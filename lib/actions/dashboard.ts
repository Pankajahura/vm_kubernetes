// // app/dashboard/actions.ts
// 'use server';

// import { z } from 'zod';
// import { buildPayloadWithFreeIps } from '@/lib/supabase/vms';
// import { vmCreateSchema, vmFetchSchema } from '../schema/vmSchema';
// // (Better: call your queue/enqueue function directly here instead of fetch)
// const API_PATH = '/api/clusters';

// type ActionState = { ok?: boolean; error?: string };

// // const schema = z.object({
// //   name: z.string().min(1),
// //   location: z.enum(['mumbai','bangalore','noida']),
// //   nodes: z.coerce.number().int().min(1).max(50),
// //   version: z.enum(['1.31.1']),
// //   plan: z.enum(['nano','micro','small']),
// // });

// // duplicate (server-side) plan map, or move to a shared module
// const NODE_PLANS: Record<string, {label: string; ram: number; cpu: number; storage: number}> = {
//   nano:  { label: 'Nano • 1GB RAM • 1 vCPU • 27GB SSD',  ram: 1, cpu: 1, storage: 27 },
//   micro: { label: 'Micro • 1GB RAM • 1 vCPU • 27GB SSD', ram: 1, cpu: 1, storage: 27 },
//   small: { label: 'Small • 1GB RAM • 1 vCPU • 27GB SSD', ram: 1, cpu: 1, storage: 27 },
// };

// export async function createClusterAction(
//   _prevState: ActionState,
//   formData: FormData
// ): Promise<ActionState> {
//   try {
//     // const input = vmFetchSchema.parse({
//     //   name: formData.get('name'),
//     //   location: formData.get('location'),
//     //   nodes: formData.get('nodes'),
//     //   version: formData.get('version'),
//     //   plan: formData.get('plan'),
//     // });

//     const planDetails = NODE_PLANS[input.ram,input.cpu,input.storage];
//     if (!planDetails) return { ok: false, error: 'Unknown plan selected.' };

//     // (Optional) enforce sane min memory for workers on the server:
//     if (planDetails.ram < 2 && input.number > 1) {
//       return { ok: false, error: 'Workers need at least 2GB RAM for stability.' };
//     }

//     let payload=await buildPayloadWithFreeIps({name:formData?.name,location:data.location,version:data.version,planDetails:data.planDetails,nodes:data.nodes});

//     // Build your provisioning payload entirely on the server
//     const result = await buildPayloadWithFreeIps({
//       name: input.username,
//       location: input.location,
//       version: input.version,
//       planDetails,
//       nodes: input.nodes,
//     });

//     if (!result?.success) {
//       return { ok: false, error: result?.error || 'No free IPs available.' };
//     }

//     // Option A (simple): call your existing route handler
//     const res = await fetch(API_PATH, {
//       method: 'POST',
//       headers: { 'content-type': 'application/json' },
//       body: JSON.stringify(result.payload),
//       // forward cookies/headers if your route needs auth:
//       // credentials: 'include',
//     });

//     if (!res.ok) {
//       const text = await res.text().catch(() => 'Failed to create cluster.');
//       return { ok: false, error: text };
//     }

//     // Option B (better): import your queue/enqueue fn and call it directly here
//     // await enqueueProvisionJob(result.payload);

//     return { ok: true };
//   } catch (e: any) {
//     console.log(e?.message);
//     return { ok: false, error: e?.message || 'Server error' };
//   }
// }
