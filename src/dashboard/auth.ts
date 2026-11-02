import "server-only";
import { getServerSession, type NextAuthOptions } from "next-auth";
import GitHubProvider from "next-auth/providers/github";
import { redirect } from "next/navigation";
import { loadDashboardEnv } from "./env";
import { allowSignIn, isOwner } from "./owner";

const SESSION_SECONDS = 7 * 24 * 3600;

export function authOptions(): NextAuthOptions {
  const env = loadDashboardEnv();
  return {
    secret: env.NEXTAUTH_SECRET,
    session: { strategy: "jwt", maxAge: SESSION_SECONDS },
    providers: [GitHubProvider({ clientId: env.GITHUB_ID, clientSecret: env.GITHUB_SECRET })],
    pages: { error: "/denied" },
    callbacks: {
      signIn: ({ account, profile }) => allowSignIn(account?.provider, (profile as { id?: unknown } | undefined)?.id, env.OWNER_GITHUB_ID),
      session: ({ session, token }) => ({ ...session, githubId: token.sub }),
    },
  };
}

/**
 * The only way to private data. Every page and server action calls it first, and
 * it compares against the configured owner on each request, so a session from
 * before an owner change, or a token minted for anyone else, gets nothing.
 */
export async function requireOwner(): Promise<void> {
  const session = (await getServerSession(authOptions())) as { githubId?: unknown } | null;
  if (!session) redirect("/api/auth/signin");
  if (!isOwner(session.githubId, loadDashboardEnv().OWNER_GITHUB_ID)) redirect("/denied");
}
