// app/vms/actions.ts
"use server";

import { createClient } from "@supabase/supabase-js";



export async function updateVmByIps(ips: string[]) {

  console.log(ips,"...............ips");
  
  const supabase = await createClient( process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await supabase
    .from("vms")
    .update({ status: "used" })
    .in("ip_address", ips) // <- match multiple rows by IP
    .eq("status", "free") // optional guard: only free -> used
    .select("id, ip_address, username, location, status, created_at");
    //console.log(error.message,"...............error.message");
  if (error) 
  {
    throw new Error(error.message);
    console.log(error.message,"...............error.message");
  }

  // if you used `next: { tags: ['vms'] }` on fetch, you can revalidate here:
  // revalidateTag('vms');

  return { success: true, message: "IP status updated successfully",data:data };
}