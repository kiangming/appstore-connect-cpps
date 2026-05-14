import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { Toaster } from 'sonner';
import { authOptions } from '@/lib/auth';
import { getStoreUser } from '@/lib/store-submissions/auth';
import { NotWhitelistedScreen } from '@/components/store-submissions/NotWhitelistedScreen';
import { StoreSubNav } from '@/components/store-submissions/layout/StoreSubNav';
import { getDuplicateForwardCount } from '@/lib/store-submissions/queries/duplicate-forwards';

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

  // PR-Inbox.ForwardDedup: trailing 30-day duplicate-forward count
  // for the sidebar nav badge. Trails toward zero post-cleanup.
  // Fetch failures degrade silently to 0 inside the query helper —
  // the layout render never blocks on the badge.
  const duplicateForwardCount = await getDuplicateForwardCount();

  return (
    <>
      <StoreSubNav duplicateForwardCount={duplicateForwardCount} />
      {children}
      <Toaster position="bottom-right" richColors closeButton />
    </>
  );
}
