"use client";
import { useEffect, useMemo, useRef, useState } from "react";

type CheckStatus = { createStatus: boolean; connectStatus: boolean; verifyStatus: boolean };

export default function StatusClient({ clusterId }: { clusterId: string }) {
  const [status, setStatus] = useState<CheckStatus>({ createStatus: false, connectStatus: false, verifyStatus: false });
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const pollRef = useRef<NodeJS.Timeout | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const alertedRef = useRef(false);

  const steps = useMemo(
    () => [
      { key: "createStatus", label: "1. Create cluster" },
      { key: "connectStatus", label: "2. connectStatus cluster" },
      { key: "verifyStatus", label: "3. verifyStatus cluster" },
    ] as const,
    []
  );

  const allDone = status.createStatus && status.connectStatus && status.verifyStatus;
  const currentIndex = useMemo(() => {
    if (!status.createStatus) return 0;
    if (!status.connectStatus) return 1;
    if (!status.verifyStatus) return 2;
    return -1; // all done
  }, [status]);

  async function pollOnce() {
    setError(null);
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const res = await fetch("/api/clusters/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clusterId }),
        signal: ac.signal,
      });

      console.log(res.ok,".............res.ok");

      if (!res.ok) {
        const msg = await res.text().catch(() => "");
        throw new Error(msg || `Status API returned ${res.status}`);
      }

      const data = (await res.json()) as Partial<CheckStatus>;

      console.log(data,".............data");

      // Merge new truthy statuses without flipping any true back to false
      setStatus(prev => ({
        createStatus: prev.createStatus || !!data.createStatus,
        connectStatus: prev.connectStatus || !!data.connectStatus,
        verifyStatus: prev.verifyStatus || !!data.verifyStatus,
      }));
      setLastUpdated(new Date());
    } catch (e: any) {
      if (e?.name !== "AbortError") setError(e?.message || "Failed to fetch status.");
    }
  }

  // Start polling on mount, stop on unmount
  useEffect(() => {
    // immediate check
    pollOnce();
    // then poll every 60s
    pollRef.current = setInterval(pollOnce, 60_000);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterId]);

  // Stop polling once all steps complete (and alert once)
  useEffect(() => {
    if (allDone) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      abortRef.current?.abort();
      if (!alertedRef.current) {
        alertedRef.current = true;
        alert("Cluster is ready!");
      }
    }
  }, [allDone]);

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-slate-50 py-10 px-4">
      <div className="mx-auto max-w-3xl">
        <h2 className="text-2xl font-semibold text-slate-900 mb-1">Getting Started with Kubernetes</h2>
        <p className="text-sm text-slate-600 mb-6">
          Cluster: <span className="font-mono">{clusterId}</span>
        </p>

        <div className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 p-6 md:p-8 space-y-5">
          {steps.map((s, idx) => {
            const done = status[s.key];
            const inProgress = !done && idx === currentIndex;
            return <StepRow key={s.key} label={s.label} done={done} inProgress={inProgress} />;
          })}

          <div className="flex items-center justify-between text-xs text-slate-500 pt-2">
            <div className="flex items-center gap-2">
              {!allDone ? (
                <span className="inline-flex items-center gap-2">
                  <Spinner />
                  <span>Checking status every 1 minute…</span>
                </span>
              ) : (
                <span className="text-emerald-600 font-medium">All steps complete.</span>
              )}
            </div>
            <div>
              {lastUpdated ? <span>Last updated: {lastUpdated.toLocaleTimeString()}</span> : <span>Waiting for first update…</span>}
            </div>
          </div>

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* --- UI bits --- */
function StepRow({ label, done, inProgress }: { label: string; done: boolean; inProgress: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <StatusDot done={done} inProgress={inProgress} />
      <div className={`text-sm md:text-base ${done ? "text-slate-900" : "text-slate-700"}`}>{label}</div>
    </div>
  );
}

function StatusDot({ done, inProgress }: { done: boolean; inProgress: boolean }) {
  if (done) {
    return (
      <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500" aria-label="done">
        <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden="true">
          <path d="M5 10.5l3 3 7-7" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  }
  if (inProgress) {
    return <span className="inline-flex h-6 w-6 rounded-full bg-blue-500" aria-label="in progress" title="in progress" />;
  }
  return <span className="inline-flex h-6 w-6 rounded-full ring-2 ring-slate-300 bg-white" aria-label="pending" title="pending" />;
}

function Spinner() {
  return (
    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}
