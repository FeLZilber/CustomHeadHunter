import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { encode } from "next-auth/jwt";
import { BASE_URL, NEXTAUTH_SECRET, OWNER_ID, STRANGER_ID, TITLES } from "./constants";

const PRIVATE_PATHS = ["/", "/saved", "/applied", "/profile", "/status", "/jobs/1"];

const sessionCookie = async (githubId: string, secret = NEXTAUTH_SECRET) => ({
  name: "next-auth.session-token",
  value: await encode({ token: { sub: githubId, name: "Test" }, secret }),
  url: BASE_URL,
});

const signIn = async (context: BrowserContext, githubId = OWNER_ID) => context.addCookies([await sessionCookie(githubId)]);

const cookieHeader = async (githubId: string, secret?: string) => {
  const { name, value } = await sessionCookie(githubId, secret);
  return `${name}=${value}`;
};

const jobRow = (page: Page, title: string) => page.locator(".job").filter({ hasText: title });

/** Reads the form React renders for a server action, so a raw POST can be replayed with any cookie. */
async function saveActionFields(page: Page, title: string) {
  const inputs = jobRow(page, title).locator("form input[type=hidden]");
  const fields: Record<string, string> = {};
  for (const input of await inputs.all()) {
    fields[(await input.getAttribute("name"))!] = (await input.getAttribute("value")) ?? "";
  }
  return fields;
}

const postAction = (request: APIRequestContext, fields: Record<string, string>, cookie: string) =>
  request.post("/", { multipart: fields, headers: { cookie, origin: BASE_URL }, maxRedirects: 0 });

test.describe("without the owner's session", () => {
  for (const path of PRIVATE_PATHS) {
    test(`${path} sends an anonymous visitor to sign in, showing no data`, async ({ request }) => {
      const response = await request.get(path, { maxRedirects: 0, headers: { cookie: "" } });
      expect(response.status()).toBe(307);
      expect(response.headers().location).toContain("/api/auth/signin");
      expect(await response.text()).not.toContain("Fixture Labs");
    });

    test(`${path} refuses a signed-in stranger, showing no data`, async ({ request }) => {
      const response = await request.get(path, { maxRedirects: 0, headers: { cookie: await cookieHeader(STRANGER_ID) } });
      expect(response.status()).toBe(307);
      expect(response.headers().location).toContain("/denied");
      expect(await response.text()).not.toContain("Fixture Labs");
    });
  }

  test("a token signed with another secret is anonymous", async ({ request }) => {
    const cookie = await cookieHeader(OWNER_ID, "some-other-secret-of-sufficient-length");
    const response = await request.get("/", { maxRedirects: 0, headers: { cookie } });
    expect(response.headers().location).toContain("/api/auth/signin");
  });

  test("a stranger lands on a page that holds no data", async ({ context, page }) => {
    await signIn(context, STRANGER_ID);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Access denied" })).toBeVisible();
    await expect(page.locator("body")).not.toContainText("Fixture Labs");
  });

  test("a server action refuses a stranger and an anonymous caller, and accepts the owner's identical request", async ({ context, page, request }) => {
    await signIn(context);
    await page.goto("/");
    const fields = await saveActionFields(page, TITLES.low);
    expect(fields.jobId).toBeTruthy();

    const stranger = await postAction(request, fields, await cookieHeader(STRANGER_ID));
    expect(stranger.headers()["x-action-redirect"] ?? stranger.headers().location).toContain("/denied");
    const anonymous = await postAction(request, fields, "");
    expect(anonymous.headers()["x-action-redirect"] ?? anonymous.headers().location).toContain("/api/auth/signin");
    await page.goto("/saved");
    await expect(page.getByText("Nothing saved yet.")).toBeVisible();

    await postAction(request, fields, await cookieHeader(OWNER_ID));
    await page.reload();
    await expect(jobRow(page, TITLES.low)).toBeVisible();

    await jobRow(page, TITLES.low).getByRole("button", { name: "Remove from saved" }).click();
    await expect(page.getByText("Nothing saved yet.")).toBeVisible();
  });
});

test.describe("as the owner", () => {
  test.beforeEach(({ context }) => signIn(context));

  test("lists current matches best first, with every other state labelled", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".job h2").nth(2)).toHaveText(TITLES.low);
    await expect(jobRow(page, TITLES.hostile).locator(".badge")).toHaveText("80/100");
    await expect(jobRow(page, TITLES.low).locator(".badge")).toHaveText("60/100");
    await expect(jobRow(page, TITLES.pending).locator(".badge")).toHaveText("Match pending");
    await expect(jobRow(page, TITLES.failed).locator(".badge")).toHaveText("Match failed");
    await expect(jobRow(page, TITLES.filtered).locator(".badge")).toHaveText("Filtered out");
  });

  test("searches and filters with the form, in Hebrew too", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Title").fill("בודק");
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page.locator(".job")).toHaveCount(1);
    await expect(page.getByRole("link", { name: TITLES.hebrew })).toHaveAttribute("dir", "auto");

    await page.goto("/?location=" + encodeURIComponent("תל אביב"));
    await expect(page.locator(".job")).toHaveCount(1);

    await page.goto("/?minScore=75");
    await expect(page.locator(".job")).toHaveCount(2);

    await page.goto("/?match=failed");
    await expect(page.locator(".job")).toHaveCount(1);
    await expect(jobRow(page, TITLES.failed)).toBeVisible();

    await page.goto("/?company=nobody");
    await expect(page.getByText("No jobs match these filters.")).toBeVisible();
  });

  test("shows hostile posting text as text and runs none of it", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: TITLES.hostile }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(TITLES.hostile);
    const description = page.locator(".description");
    await expect(description).toContainText("<script>window.__pwned = true</script>");
    await expect(description).toContainText(`<img src="x"`);
    await expect(description.locator("script, img")).toHaveCount(0);
    expect(await page.evaluate(() => "__pwned" in window)).toBe(false);
  });

  test("separates quotes found in the posting from quotes that are not", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: TITLES.hostile }).click();
    await expect(page.getByText("1 of 2 quotes found in posting")).toBeVisible();
    await expect(page.getByRole("listitem").filter({ hasText: "Automation:" })).toContainText("Quote found in posting");
    await expect(page.getByRole("listitem").filter({ hasText: "Go:" })).toContainText("Quote not found in posting");
    await expect(page.getByRole("listitem").filter({ hasText: "Clearance:" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open original posting" })).toHaveAttribute("rel", /noopener/);
  });

  test("explains a pending job instead of giving it a score", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: TITLES.pending }).click();
    await expect(page.getByText("This job is waiting for the model.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Match details" })).toHaveCount(0);
  });

  test("gives a 404 for an unknown or malformed job id", async ({ page }) => {
    expect((await page.goto("/jobs/999999"))!.status()).toBe(404);
    expect((await page.goto("/jobs/1%27%20OR%201=1"))!.status()).toBe(404);
  });

  test("saves and removes a job", async ({ page }) => {
    await page.goto("/");
    await jobRow(page, TITLES.hebrew).getByRole("button", { name: "Save job" }).click();
    await expect(jobRow(page, TITLES.hebrew).getByRole("button", { name: "Remove from saved" })).toBeVisible();
    await page.goto("/saved");
    await expect(jobRow(page, TITLES.hebrew)).toBeVisible();
    await jobRow(page, TITLES.hebrew).getByRole("button", { name: "Remove from saved" }).click();
    await expect(page.getByText("Nothing saved yet.")).toBeVisible();
  });

  test("marks a job as applied from its page, lists it, and undoes it", async ({ page }) => {
    await page.goto("/applied");
    await expect(page.getByText("No applications marked yet.")).toBeVisible();

    await page.goto("/");
    await page.getByRole("link", { name: TITLES.hebrew }).click();
    await page.getByRole("button", { name: "Mark as applied" }).click();
    await expect(page.getByRole("button", { name: /^Applied .*, undo$/ })).toBeVisible();

    await page.goto("/applied");
    await expect(jobRow(page, TITLES.hebrew)).toContainText("Applied");
    await page.goto("/");
    await expect(jobRow(page, TITLES.hebrew).locator(".badge-applied")).toBeVisible();

    await page.goto("/applied");
    await page.getByRole("link", { name: TITLES.hebrew }).click();
    await page.getByRole("button", { name: /^Applied .*, undo$/ }).click();
    await expect(page.getByRole("button", { name: "Mark as applied" })).toBeVisible();
    await page.goto("/applied");
    await expect(page.getByText("No applications marked yet.")).toBeVisible();
  });

  test("shows failures that need attention on the status page", async ({ page }) => {
    await page.goto("/status");
    await expect(page.getByRole("listitem").filter({ hasText: "Broken Co" })).toContainText("failed");
    await expect(page.getByRole("listitem").filter({ hasText: "ambiguous" })).toContainText("Connection lost");
    await expect(page.getByText("1 pending, 1 failed after all attempts")).toBeVisible();
  });

  test("editing the profile adds a revision and marks results out of date until it is restored", async ({ page }) => {
    await page.goto("/profile");
    const revision = Number(/Revision (\d+)/.exec((await page.locator(".meta").first().textContent())!)![1]);
    const industries = page.getByLabel("Preferred industries");
    const original = await industries.inputValue();

    await page.getByRole("button", { name: "Save profile" }).click();
    await expect(page.getByText("Profile saved.")).toBeVisible();
    await expect(page.getByText(`Revision ${revision}.`)).toBeVisible();

    await industries.fill(`${original}\nLogistics`);
    await page.getByRole("button", { name: "Save profile" }).click();
    await expect(page.getByText(`Revision ${revision + 1}.`)).toBeVisible();

    await page.goto("/");
    await expect(jobRow(page, TITLES.hostile).locator(".badge")).toHaveText("Out of date · was 80");
    await page.getByRole("link", { name: TITLES.hostile }).click();
    await expect(page.getByText("shown for reference only")).toBeVisible();

    await page.goto("/profile");
    await page.getByLabel("Preferred industries").fill(original);
    await page.getByRole("button", { name: "Save profile" }).click();
    await expect(page.getByText(`Revision ${revision + 2}.`)).toBeVisible();
    await page.goto("/");
    await expect(jobRow(page, TITLES.hostile).locator(".badge")).toHaveText("80/100");
  });

  test("rejects an invalid profile, naming the field and saving nothing", async ({ page }) => {
    await page.goto("/profile");
    const before = await page.locator(".meta").first().textContent();
    await page.getByLabel("Experience from (years)").fill("9");
    await page.getByLabel("Experience to (years)").fill("1");
    await page.getByRole("button", { name: "Save profile" }).click();
    await expect(page.locator(".notice-error")).toContainText("Experience");
    await expect(page.locator(".meta").first()).toHaveText(before!);
  });

  test("ignores an unknown field name in the error parameter", async ({ page }) => {
    await page.goto("/profile?invalid=<script>alert(1)</script>");
    await expect(page.locator(".notice-error")).toHaveCount(0);
  });

  test("sends protective headers and no CSP violations", async ({ page }) => {
    const violations: string[] = [];
    page.on("console", (message) => {
      if (/Content Security Policy/i.test(message.text())) violations.push(message.text());
    });
    const headers = (await page.goto("/"))!.headers();
    await expect(jobRow(page, TITLES.low)).toBeVisible();
    expect(violations).toEqual([]);
    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("no-referrer");
    expect(headers["cache-control"]).toContain("no-store");
    expect(headers["x-powered-by"]).toBeUndefined();
  });

  test("fits a phone screen with no sideways scrolling", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    for (const path of ["/", "/profile", "/status"]) {
      await page.goto(path);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, path).toBeLessThanOrEqual(0);
    }
  });
});
