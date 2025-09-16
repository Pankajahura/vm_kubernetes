// app/dashboard/page.tsx
"use client";

import React, { useMemo, useState } from "react";
import axios, { AxiosResponse } from 'axios';

type Location = "mumbai" | "bangalore" | "noida";
type Version = "1.31.1";
type PlanId = "nano" | "micro" | "small";

const NODE_PLANS: Record<
  PlanId,
  { label: string; ram: number; cpu: number; storage: string }
> = {
  nano: { label: "Nano • 512MB RAM • 1 vCPU • 2GB SSD", ram: 512, cpu: 1, storage: "2GB" },
  micro: { label: "Micro • 1GB RAM • 1 vCPU • 10GB SSD", ram: 1024, cpu: 1, storage: "10GB" },
  small: { label: "Small • 2GB RAM • 1 vCPU • 25GB SSD", ram: 2048, cpu: 1, storage: "25GB" },
};

export default function NewClusterPage() {
  const [name, setName] = useState("");
  const [location, setLocation] = useState<Location>("mumbai");
  const [nodes, setNodes] = useState<number>(1);
  const [version, setVersion] = useState<Version>("1.31.1");
  const [plan, setPlan] = useState<PlanId>("nano");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  const planMeta = useMemo(() => NODE_PLANS[plan], [plan]);

  const incNodes = () => setNodes((n) => Math.min(n + 1, 50));
  const decNodes = () => setNodes((n) => Math.max(n - 1, 1));

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setOkMsg(null);

    if (!name.trim()) {
      setError("Please provide a cluster name.");
      return;
    }

    setSubmitting(true);

    // This is where you'd POST to your API route, e.g. /api/clusters
    const data = {
      name: name.trim(),
      location,
      nodes,
      version,
      plan,
      planDetails: planMeta,
      // add any extra derived fields here
    };

    try {
      // Example: just log & show confirmation (replace with real fetch)

      //need to configure ip and password manually..
      //get free ip and password from db . 
      //console.log("[create-cluster] payload:", data);
     let payload= {
  provider: "existing",
  cluster: { name: data.name, location: data.location, pod_cidr: "10.244.0.0/16", k8s_minor: data.version },
  auth: { method: "password", user: "root", password: "luV5DivOV98g" },
  nodes: {
    "cp-1": { host: "172.104.206.68", role: "control-plane", hostname: "cp-1", cpu: data.planDetails.cpu, memory_mb: data.planDetails.ram }
  }
}

  
   

//once cluster is build , update the ip with in_use status.
console.log(payload,"..........................69");


let response =await axios.post('/api/clusters',payload);

  if(response.status==200){
    alert('your cluster is being created. please wait for some time.......', );
     setOkMsg("Cluster request captured. Check console for payload.");
  }





 




      // await new Promise((r) => setTimeout(r, 600)); // simulate latency
     
    } catch (err: any) {
      console.log(err,".........98")
      setError(err?.message || "Something went wrong while submitting.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-slate-50 py-10 px-4">
      <div className="mx-auto max-w-3xl">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-slate-900">Create Kubernetes Cluster</h1>
          <p className="text-sm text-slate-600 mt-1">
            Fill the form to provision a new cluster. You can tweak size and region anytime before launch.
          </p>
        </div>

        {/* Card */}
        <div className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
          <form onSubmit={handleSubmit} className="p-6 md:p-8 space-y-6">
            {/* Cluster Name */}
            <div className="space-y-2">
              <label htmlFor="name" className="block text-sm font-medium text-slate-800">
                Cluster name
              </label>
              <input
                id="name"
                name="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., prod-observability"
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <p className="text-xs text-slate-500">Letters, numbers, and dashes only are recommended.</p>
            </div>

            {/* Grid: location, nodes, version */}
            <div className="grid gap-6 md:grid-cols-3">
              {/* Location */}
              <div className="space-y-2">
                <label htmlFor="location" className="block text-sm font-medium text-slate-800">
                  Location
                </label>
                <select
                  id="location"
                  name="location"
                  value={location}
                  onChange={(e) => setLocation(e.target.value as Location)}
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="mumbai">Mumbai</option>
                  <option value="bangalore">Bangalore</option>
                  <option value="noida">Noida</option>
                </select>
              </div>

              {/* Nodes with + / - */}
              <div className="space-y-2">
                <label className="block text-sm font-medium text-slate-800">Number of nodes</label>
                <div className="flex items-stretch rounded-xl border border-slate-300 overflow-hidden">
                  <button
                    type="button"
                    onClick={decNodes}
                    className="px-3 text-slate-700 hover:bg-slate-100 active:bg-slate-200"
                    aria-label="Decrease nodes"
                  >
                    −
                  </button>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={50}
                    value={nodes}
                    onChange={(e) => {
                      const val = Number(e.target.value || "1");
                      setNodes(Math.max(1, Math.min(50, val)));
                    }}
                    className="w-full text-center px-2 py-2 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={incNodes}
                    className="px-3 text-slate-700 hover:bg-slate-100 active:bg-slate-200"
                    aria-label="Increase nodes"
                  >
                    +
                  </button>
                </div>
                <p className="text-xs text-slate-500">Minimum 1, maximum 50.</p>
              </div>

              {/* Version */}
              <div className="space-y-2">
                <label htmlFor="version" className="block text-sm font-medium text-slate-800">
                  Kubernetes version
                </label>
                <select
                  id="version"
                  name="version"
                  value={version}
                  onChange={(e) => setVersion(e.target.value as Version)}
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="1.31.1">1.31.1</option>
                </select>
              </div>
            </div>

            {/* Node Plan */}
            <div className="space-y-2">
              <label htmlFor="plan" className="block text-sm font-medium text-slate-800">
                Node plan
              </label>
              <select
                id="plan"
                name="plan"
                value={plan}
                onChange={(e) => setPlan(e.target.value as PlanId)}
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                {Object.entries(NODE_PLANS).map(([id, p]) => (
                  <option key={id} value={id}>
                    {p.label}
                  </option>
                ))}
              </select>
              <div className="text-xs text-slate-600">
                <span className="font-medium">Selected:</span> {planMeta.ram} RAM • {planMeta.cpu} vCPU • {planMeta.storage} storage
              </div>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between pt-2">
              <div className="text-sm">
                {error && <span className="text-red-600">{error}</span>}
                {okMsg && <span className="text-emerald-600">{okMsg}</span>}
              </div>
              <button
                type="submit"
                disabled={submitting}
                className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-white shadow-sm hover:bg-indigo-700 active:bg-indigo-800 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {submitting ? "Submitting…" : "Create cluster"}
              </button>
            </div>
          </form>
        </div>

        {/* Small note */}
        <p className="mt-4 text-xs text-slate-500">
          On submit, the data is validated client-side and logged to the console. Replace the submit block with your API call.
        </p>
      </div>
    </div>
  );
}
