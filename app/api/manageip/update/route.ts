// import { vmCreateSchema } from "@/lib/schema/vmSchema";
import { createSSRClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";
// import { success } from "zod";


// function isUUID(v: string) {
//   return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
// }

// async function getUserIdOr401() {
//   const supabase =await createSSRClient();
//   const { data: { user } } = await supabase.auth.getUser();
//   if (!user) {
//     return { userId: null as string | null, response: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) };
//   }
//   return { userId: user.id, response: null};
// }

export async function POST(req: NextRequest) {
 // const auth = await getUserIdOr401();
//   if (auth.response) return auth.response;

 // const id = params.id;
  const json = await req.json();
    // const parsed = vmCreateSchema.parse(json);
//   if (!isUUID(id)) {
//     return NextResponse.json({ error: 'Invalid VM id' }, { status: 400 });
//   }
console.log(json,".............29........");

  const supabase =await createSSRClient();

  // Update only if the row belongs to the user (RLS enforces), and try to avoid races by ensuring it was free.
  const { data, error } = await supabase
  .from('vms')
  .update({ status: 'used' })
  .in('ip_address', json.ipAddress)   // <- match multiple rows by IP
  .eq('status', 'free')    // optional guard: only free -> used
  .select('id, ip_address, username, location, status, created_at');

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  if (!data) return NextResponse.json({ error: 'Not found or already used' }, { status: 404 });

  return NextResponse.json({
    
    success:true,
    message:"IP status updated successfully",
    // id: data.id,
    // ipAddress: data.ip_address,
    // username: data.username,
    // location: data.location,
    // status: data.status,
    // createdAt: data.created_at,
  });
}
