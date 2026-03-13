import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";

// Extend session + JWT types to include activeAccountId
declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
    };
    activeAccountId: string | null;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    activeAccountId?: string | null;
  }
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
    CredentialsProvider({
      name: "Credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;

        // Replace with real user lookup from Supabase or environment-based auth
        const adminEmail = process.env.ADMIN_EMAIL;
        const adminPassword = process.env.ADMIN_PASSWORD;

        if (
          credentials.email === adminEmail &&
          credentials.password === adminPassword
        ) {
          return { id: "1", name: "Admin", email: credentials.email };
        }

        return null;
      },
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
      return true;
    },
    async jwt({ token, user, trigger, session }) {
      if (user) token.id = user.id;

      // Handle session update triggered by useSession().update({ activeAccountId })
      if (trigger === "update" && session?.activeAccountId !== undefined) {
        token.activeAccountId = session.activeAccountId as string | null;
      }

      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
      }
      session.activeAccountId = token.activeAccountId ?? null;
      return session;
    },
  },
};
