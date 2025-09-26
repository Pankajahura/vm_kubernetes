import { NextRequest, NextResponse } from 'next/server';
import { vmCreateSchema } from '@/lib/schema/vmSchema';
import bcrypt from 'bcryptjs';
import { createSSRClient } from '@/lib/supabase/server';

// async function getUserIdOr401() {
//   const supabase = await createSSRClient();
//   const { data: { user } } = await supabase.auth.getUser();
//   if (!user) {
//     return { userId: null as string | null, response: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) };
//   }
//   return { userId: user.id, response: null };
// }

export async function POST(req: NextRequest) {
  // Require auth
  //const auth = await getUserIdOr401();
  //if (auth.response) return auth.response;

  try {
    const json = await req.json();
    const parsed = vmCreateSchema.parse(json);

    const supabase =await createSSRClient();
    const password_hash = await bcrypt.hash(parsed.password, 10);

    const { data, error } = await supabase
      .from('vms')
      .insert({
        ip_address: parsed.ipAddress,
        username: parsed.username,
        password_hash,
        location: parsed.location,
        status: parsed.status ?? 'free',
        ram: parsed.ram,
        cpu: parsed.cpu,
        storage: parsed.storage,
      })
      .select('id, ip_address, username, location, status,ram,cpu,storage, created_at')
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 400 });

    return NextResponse.json({
      id: data.id,
      ipAddress: data.ip_address,
      username: data.username,
      location: data.location,
      status: data.status,
      ram: data.ram,
        cpu: data.cpu,
        storage: data.storage,
      createdAt: data.created_at,
    }, { status: 201 });
  } catch (err: unknown) {
  if (err instanceof Error) {
    return NextResponse.json({ error: err.message ?? 'Invalid request' }, { status: 400 });
  } else {
    return NextResponse.json({ error: 'Unknown error occurred' }, { status: 400 });
  }
}
}


