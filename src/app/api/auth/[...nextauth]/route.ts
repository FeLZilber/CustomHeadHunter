import type { NextRequest } from "next/server";
import NextAuth from "next-auth";
import { authOptions } from "../../../../dashboard/auth";

type Context = { params: Promise<{ nextauth: string[] }> };

const handler = (request: NextRequest, context: Context) => NextAuth(request, context, authOptions());

export { handler as GET, handler as POST };
