import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { getStoreUser } from '@/lib/store-submissions/auth';
import { NotWhitelistedScreen } from '@/components/store-submissions/NotWhitelistedScreen';

export const dynamic = 'force-dynamic';

export default async function StoreSubmissionsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    redirect('/login');
  }

  const storeUser = await getStoreUser(session.user.email);
  if (!storeUser) {
    return <NotWhitelistedScreen email={session.user.email} />;
  }

  return <>{children}</>;
}
