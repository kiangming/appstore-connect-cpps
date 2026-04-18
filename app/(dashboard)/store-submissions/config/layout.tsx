import { ConfigSubNav } from '@/components/store-submissions/layout/ConfigSubNav';

export default function ConfigLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <ConfigSubNav />
      <div className="flex-1 overflow-auto">{children}</div>
    </div>
  );
}
