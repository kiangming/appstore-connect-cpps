import type { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";

// Extend session + JWT types
declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
      role: "admin" | "member";
    };
    activeAccountId: string | null;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    role?: "admin" | "member";
    activeAccountId?: string | null;
  }
}

function isAdminEmail(email: string): boolean {
  const adminEmails = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  return adminEmails.includes(email);
}

export const authOptions: NextAuthOptions = {
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
  },
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],
  callbacks: {
    async signIn({ account, profile }) {
      if (account?.provider === "google") {
        const allowed = (process.env.GOOGLE_ALLOWED_EMAILS ?? "")
          .split(",")
          .map((e) => e.trim())
          .filter(Boolean);
        return allowed.includes(profile?.email ?? "");
      }
      return false;
    },
    async jwt({ token, profile, trigger, session }) {
      // profile is only present on initial sign-in — set role once
      if (profile?.email) {
        token.role = isAdminEmail(profile.email) ? "admin" : "member";
      }

      // Handle session update triggered by useSession().update({ activeAccountId })
      if (trigger === "update" && session?.activeAccountId !== undefined) {
        token.activeAccountId = session.activeAccountId as string | null;
      }

      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.sub ?? "";
        session.user.role = token.role ?? "member";
      }
      session.activeAccountId = token.activeAccountId ?? null;
      return session;
    },
  },
};
