import StatusClient from "@/components/dashboard/status";
type Params = { clientId: string };
// app/dashboard/[clusterId]/status/page.tsx
export default async function Page({
  params,
}: {
  params: Promise<Params>;
}) {

     const { clientId } = await params;   
  const clusterId =  decodeURIComponent(clientId);
  console.log(clientId,"...............clusterId");

  return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold">Cluster Status</h1>
      <p className="text-slate-600 mt-1">
        Cluster ID: <span className="font-mono">{clusterId}</span>
      </p>

      {/* pass clusterId to a client component if you need polling */}
      <StatusClient clusterId={clusterId} />
    </main>
  );
}
