import { vmFetchSchema } from "@/lib/schema/vmSchema";
import { createSSRClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";


// async function getUserIdOr401() {
//   const supabase = await createSSRClient();
//   const { data: { user } } = await supabase.auth.getUser();
//   if (!user) {
//     return { userId: null as string | null, response: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) };
//   }
//   return { userId: user.id, response: null};
// }

export async function GET(req: NextRequest) {
 // const auth = await getUserIdOr401();
 // if (auth.response) return auth.response;

  try {
    const { searchParams } = new URL(req.url);
    const location = searchParams.get('location') ?? '';
    const number = searchParams.get('number') ?? undefined;
    const ram = searchParams.get('ram') ?? undefined;
    const cpu = searchParams.get('cpu') ?? undefined;
    const storage = searchParams.get('storage') ?? undefined;

    console.log(typeof(number),ram,storage,"......cpu,ram,storage...........")

    const parsed = vmFetchSchema.parse({ location, number,ram,cpu,storage});

    const supabase = await createSSRClient();

    
    const { data, error } = await supabase
      .from('vms')
      .select('id, ip_address, username, location,ram,cpu,storage, status, created_at')
      .eq('location', parsed.location)
      .eq('status', 'free')
      .eq('ram', parsed.ram)
      .eq('cpu', parsed.cpu)
      .eq('storage', parsed.storage)
      .order('created_at', { ascending: true })
      .limit(parsed.number);


      if(data&& data.length<parsed.number){   
        return NextResponse.json({ error: "currently , we are out of service. Insufficient vm in db" }, { status: 400 });
      }

    if (error) return NextResponse.json({ error: error.message }, { status: 400 });

    return NextResponse.json(
      (data ?? []).map(r => ({
        id: r.id,
        ipAddress: r.ip_address,
        username: r.username,
        location: r.location,
        status: r.status,
        createdAt: r.created_at,
      }))
    );
  } catch (err: unknown) {
     if (err instanceof Error) {
    return NextResponse.json({ error: err.message ?? 'Invalid request' }, { status: 400 });
  } else {
    return NextResponse.json({ error: 'Unknown error occurred' }, { status: 400 });
  }
  }
}