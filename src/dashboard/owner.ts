/** GitHub's numeric id is immutable, unlike a login, which can be renamed and reclaimed by someone else. */
export const isOwner = (githubId: unknown, ownerId: string): boolean =>
  typeof githubId === "string" && githubId !== "" && githubId === ownerId;

export const allowSignIn = (provider: string | undefined, githubId: unknown, ownerId: string): boolean =>
  provider === "github" && isOwner(typeof githubId === "number" ? String(githubId) : githubId, ownerId);
