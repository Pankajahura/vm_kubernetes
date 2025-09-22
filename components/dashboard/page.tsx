// app/dashboard/FormClient.tsx
'use client';

import React, { useActionState, useMemo, useState } from 'react';
import {  useFormStatus } from 'react-dom';

type Location = 'mumbai' | 'bangalore' | 'noida';
type Version = '1.31.1';
type PlanId = 'nano' | 'micro' | 'small';

const NODE_PLANS: Record<PlanId, { label: string; ram: number; cpu: number; storage: number }> = {
  nano:  { label: 'Nano • 1GB RAM • 1 vCPU • 27GB SSD', ram: 1, cpu: 1, storage: 27 },
  micro: { label: 'Micro • 1GB RAM • 1 vCPU • 27GB SSD', ram: 1, cpu: 1, storage: 27 },
  small: { label: 'Small • 1GB RAM • 1 vCPU • 27GB SSD', ram: 1, cpu: 1, storage: 27 },
};

type Props = {
  action: (prev: { ok?: boolean; error?: string }, formData: FormData) => Promise<{ ok?: boolean; error?: string }>;
};

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-white shadow-sm hover:bg-indigo-700 active:bg-indigo-800 disabled:opacity-60 disabled:cursor-not-allowed"
    >
      {pending ? 'Submitting…' : 'Create cluster'}
    </button>
  );
}

export default function NewClusterForm({ action }: Props) {
  const [name, setName] = useState('');
  const [location, setLocation] = useState<Location>('mumbai');
  const [nodes, setNodes] = useState<number>(1);
  const [version, setVersion] = useState<Version>('1.31.1');
  const [plan, setPlan] = useState<PlanId>('nano');

  const [state, formAction] = useActionState(action, { ok: undefined, error: undefined });

  const planMeta = useMemo(() => NODE_PLANS[plan], [plan]);
  const incNodes = () => setNodes((n) => Math.min(n + 1, 50));
  const decNodes = () => setNodes((n) => Math.max(n - 1, 1));

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-slate-50 py-10 px-4">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-slate-900">Create Kubernetes Cluster</h1>
          <p className="text-sm text-slate-600 mt-1">Fill the form to provision a new cluster.</p>
        </div>

        <div className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
          {/* IMPORTANT: use action={formAction} (Server Action) instead of onSubmit/axios */}
          <form action={formAction} className="p-6 md:p-8 space-y-6">
            {/* cluster name */}
            <div className="space-y-2">
              <label htmlFor="name" className="block text-sm font-medium text-slate-800">Cluster name</label>
              <input id="name" name="name" value={name} onChange={(e) => setName(e.target.value)}
                     className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                     placeholder="e.g., prod-observability"/>
            </div>

            {/* Grid */}
            <div className="grid gap-6 md:grid-cols-3">
              {/* location */}
              <div className="space-y-2">
                <label className="block text-sm font-medium text-slate-800">Location</label>
                <select name="location" value={location} onChange={(e) => setLocation(e.target.value as Location)}
                        className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500">
                  <option value="mumbai">Mumbai</option>
                  <option value="bangalore">Bangalore</option>
                  <option value="noida">Noida</option>
                </select>
              </div>

              {/* nodes */}
              <div className="space-y-2">
                <label className="block text-sm font-medium text-slate-800">Number of nodes</label>
                <div className="flex items-stretch rounded-xl border border-slate-300 overflow-hidden">
                  <button type="button" onClick={decNodes} className="px-3 text-slate-700 hover:bg-slate-100 active:bg-slate-200">−</button>
                  <input type="number" name="nodes" min={1} max={50} value={nodes}
                         onChange={(e) => setNodes(Math.max(1, Math.min(50, Number(e.target.value || '1'))))}
                         className="w-full text-center px-2 py-2 focus:outline-none"/>
                  <button type="button" onClick={incNodes} className="px-3 text-slate-700 hover:bg-slate-100 active:bg-slate-200">+</button>
                </div>
              </div>

              {/* version */}
              <div className="space-y-2">
                <label className="block text-sm font-medium text-slate-800">Kubernetes version</label>
                <select name="version" value={version} onChange={(e) => setVersion(e.target.value as Version)}
                        className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500">
                  <option value="1.31.1">1.31.1</option>
                </select>
              </div>
            </div>

            {/* plan */}
            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-800">Node plan</label>
              <select name="plan" value={plan} onChange={(e) => setPlan(e.target.value as PlanId)}
                      className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500">
                {Object.entries(NODE_PLANS).map(([id, p]) => (
                  <option key={id} value={id}>{p.label}</option>
                ))}
              </select>
              <div className="text-xs text-slate-600">
                <span className="font-medium">Selected:</span> {planMeta.ram} RAM • {planMeta.cpu} vCPU • {planMeta.storage} storage
              </div>
            </div>

            {/* footer */}
            <div className="flex items-center justify-between pt-2">
              <div className="text-sm">
                {state?.error && <span className="text-red-600">{state.error}</span>}
                {state?.ok && <span className="text-emerald-600">Cluster request captured.</span>}
              </div>
              <SubmitButton/>
            </div>
          </form>
        </div>

        <p className="mt-4 text-xs text-slate-500">
          This form posts to a Server Action; secrets stay on the server.
        </p>
      </div>
    </div>
  );
}
