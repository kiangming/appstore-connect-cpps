import { LoginForm } from "@/components/auth/LoginForm";

export default function LoginPage() {
  const adminEnabled = process.env.ADMIN_ENABLE === "1";
  return <LoginForm adminEnabled={adminEnabled} />;
}
