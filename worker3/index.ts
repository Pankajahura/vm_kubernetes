import "dotenv/config";
import { Worker, Job } from "bullmq";
import IORedis from "ioredis";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { updateVmByIps } from "../lib/supabase/vms";
import {
  createClusterWorker,
  updateClusterPhaseWorker,
  updateClusterWorker,
} from "../lib/supabase/cluster";

import crypto from "node:crypto";

const execFileAsync = promisify(execFile);
// ---------- ENV ----------
const REDIS_URL = process.env.REDIS_URL!;
const QUEUE_NAME = process.env.QUEUE_NAME || "provision-queue";
const POD_CIDR_DEFAULT = process.env.POD_CIDR || "10.244.0.0/16";
const KUBECONFIG_DIR = process.env.KUBECONFIG_DIR || "/srv/kubeconfigs";
const CALICO_URL =
  process.env.CALICO_URL ||
  "https://raw.githubusercontent.com/projectcalico/calico/v3.28.0/manifests/calico.yaml";

// version handling: accept env K8S_SERIES="v1.31" or K8S_MINOR="1.31"
function toSeries(x?: string | number): string {
  const s = (x ?? "v1.31").toString();
  const withV = s.startsWith("v") ? s : `v${s}`;
  const m = withV.match(/^v\d+\.\d+/);
  return m ? m[0] : "v1.31";
}
// kubeadm version: allow pin via K8S_VERSION (e.g. v1.31.1 or stable-1.31),
// otherwise default to latest patch of the series
function toKubeadmVersion(series: string, pin?: string): string {
  if (pin) return pin; // "v1.31.1" or "stable-1.31"
  return `stable-${series.slice(1)}`;
}

const K8S_SERIES = toSeries(process.env.K8S_SERIES ?? process.env.K8S_MINOR);
const KUBEADM_VERSION = toKubeadmVersion(K8S_SERIES, process.env.K8S_VERSION);

// ---------- Types ----------
type Role = "control-plane" | "worker";
type Auth =
  | { method: "password"; user: string; password: string }
  | { method: "key"; user: string; private_key_path: string };

type NodeSpec = {
  host: string;
  role: Role;
  hostname?: string;
  cpu?: number;
  memory_mb?: number;
};
type JobData = {
  clusterId: string;
  provider: "existing";
  cluster: {
    name: string;
    location: string;
    pod_cidr?: string;
    k8s_minor?: number | string;
  };
  auth: Auth;
  nodes: Record<string, NodeSpec>;
};

// ---------- Redis ----------
const connection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

function dest(auth: Auth, host: string) {
  if (host.includes("@")) throw new Error(`host must not contain '@': ${host}`);
  return `${auth.user}@${host}`;
}

// ---------- SSH helpers ----------
function sshBaseArgs(auth: Auth, host: string) {
  const d = dest(auth, host);
  const common = [
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "ConnectTimeout=20",
    "-o",
    "NumberOfPasswordPrompts=1",
    "-o",
    "PreferredAuthentications=keyboard-interactive,password",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=4",
  ];
  if (auth.method === "password") {
    return {
      bin: "sshpass",
      args: [
        "-p",
        auth.password,
        "ssh",
        ...common,
        "-o",
        "PubkeyAuthentication=no",
        d,
      ],
    };
  }
  return { bin: "ssh", args: ["-i", auth.private_key_path, ...common, d] };
}

async function sshExec(
  auth: Auth,
  host: string,
  oneStringCmd: string,
  tag?: string
) {
  const { bin, args } = sshBaseArgs(auth, host);
  //const script = typeof oneStringCmd === "string" ? oneStringCmd : String(oneStringCmd);
  //  const quoted = JSON.stringify(script);
  const { stdout, stderr } = await execFileAsync(
    bin,
    [...args, "bash", "-lc", oneStringCmd], // ONE string after -lc
    { encoding: "utf8" }
  );
  if (stderr?.trim()) console.warn(`[ssh:${tag ?? host}] ${stderr.trim()}`);
  return stdout.trim();
}

async function scpFrom(
  auth: Auth,
  host: string,
  remote: string,
  local: string
) {
  await fs.mkdir(path.dirname(local), { recursive: true });
  if (auth.method === "password") {
    const args = [
      "-p",
      auth.password,
      "scp",
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      "ServerAliveInterval=30",
      "-o",
      "ServerAliveCountMax=4", // <-- removed stray leading space
      `${auth.user}@${host}:${remote}`,
      local,
    ];
    await execFileAsync("sshpass", args);
  } else {
    const args = [
      "-i",
      auth.private_key_path,
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      `${auth.user}@${host}:${remote}`,
      local,
    ];
    await execFileAsync("scp", args);
  }
}

async function getHostInfo(auth: Auth, host: string) {
  const cmd = `set -e; printf '%s %s %s\\n' \
"$(hostnamectl --static 2>/dev/null || hostname)" \
"$(nproc)" \
"$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)"`;
  const out = await sshExec(auth, host, cmd, "host-info");
  const [hn, cpuStr, memStr] = out.trim().split(/\s+/);
  return { hostname: hn, cpu: Number(cpuStr), memory_mb: Number(memStr) };
}

// sudo wrapper returns JUST a string; outer layer already does sh -lc
function sudoWrap(auth: Auth, raw: string) {
  const body = `export DEBIAN_FRONTEND=noninteractive; ${raw}`;
  if (auth.user === "root") return body;
  if (auth.method === "password") {
    const pw = auth.password.replace(/'/g, `'\\''`);
    return `set -e; echo '${pw}' | sudo -S -p '' bash -lc ${JSON.stringify(
      body
    )}`;
  }
  return `sudo bash -lc ${JSON.stringify(body)}`;
}

// ---------- Provision steps ----------
async function bootstrapNode(auth: Auth, host: string, k8sSeries: string) {
  if (!/^v\d+\.\d+$/.test(k8sSeries))
    throw new Error(`k8sSeries must be like "v1.31", got: ${k8sSeries}`);

  //   const script = String.raw`
  // set -eux
  // export DEBIAN_FRONTEND=noninteractive

  // # 0) Remove any old/bad Kubernetes repo before the FIRST update
  // rm -f /etc/apt/sources.list.d/kubernetes.list /etc/apt/keyrings/kubernetes-apt-keyring.gpg || true

  // # 1) Base deps
  // apt-get update -y
  // apt-get install -y ca-certificates curl gnupg lsb-release apt-transport-https

  // # 2) Disable swap (and persist)
  // swapoff -a || true
  // sed -i.bak '/\sswap\s/d' /etc/fstab || true

  // # 3) Docker/containerd repo (quote-safe)
  // . /etc/os-release
  // ARCH="$(dpkg --print-architecture)"
  // curl -fsSL "https://download.docker.com/linux/${'${ID}'}/gpg" | gpg --dearmor --batch --yes -o /etc/apt/keyrings/docker.gpg
  // cat >/etc/apt/sources.list.d/docker.list <<EOF
  // deb [arch=${'${ARCH}'} signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${'${ID}'} ${'${VERSION_CODENAME}'} stable
  // EOF

  // apt-get update -y
  // apt-get install -y containerd.io
  // mkdir -p /etc/containerd
  // containerd config default | tee /etc/containerd/config.toml >/dev/null
  // sed -i 's/^\s*SystemdCgroup = false/\tSystemdCgroup = true/' /etc/containerd/config.toml
  // systemctl enable --now containerd
  // systemctl restart containerd

  // # 4) Kubernetes repo (use a VALID series, e.g. v1.31)
  // K8S_SERIES="v1.31"
  // install -m 0755 -d /etc/apt/keyrings
  // curl -fsSL "https://pkgs.k8s.io/core:/stable:/${K8S_SERIES}/deb/Release.key" \
  //   | gpg --dearmor --batch --yes -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg
  // chmod 0644 /etc/apt/keyrings/kubernetes-apt-keyring.gpg
  // cat >/etc/apt/sources.list.d/kubernetes.list <<EOF
  // deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/${K8S_SERIES}/deb/ /
  // EOF

  // apt-get update -y
  // apt-get install -y kubelet kubeadm kubectl
  // apt-mark hold kubelet kubeadm kubectl

  // # 5) sysctl
  // cat >/etc/sysctl.d/99-kubernetes-cri.conf <<'EOF'
  // net.bridge.bridge-nf-call-iptables  = 1
  // net.ipv4.ip_forward                 = 1
  // net.bridge.bridge-nf-call-ip6tables = 1
  // EOF
  // sysctl --system >/dev/null

  // `;
  const script = String.raw`
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

# 0) Clean any bad Kubernetes repo FIRST
rm -f /etc/apt/sources.list.d/kubernetes.list /etc/apt/keyrings/kubernetes-apt-keyring.gpg || true


# 1) Base deps
apt-get update -y
apt-get install -y ca-certificates curl gnupg lsb-release apt-transport-https

# Ensure keyrings dir exists
install -m 0755 -d /etc/apt/keyrings

# 2) Disable swap (and persist)
swapoff -a || true
sed -i.bak '/\\sswap\\s/d' /etc/fstab || true

# 3) Docker/containerd repo (quote-safe; no $(...) in the string)
. /etc/os-release
ARCH="$(dpkg --print-architecture)"
rm -f /etc/apt/keyrings/docker.gpg
curl -fsSL "https://download.docker.com/linux/${"${ID}"}/gpg" \
  | gpg --dearmor --batch --yes -o /etc/apt/keyrings/docker.gpg
chmod 0644 /etc/apt/keyrings/docker.gpg
cat >/etc/apt/sources.list.d/docker.list <<EOF
deb [arch=${"${ARCH}"} signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${"${ID}"} ${"${VERSION_CODENAME}"} stable
EOF

apt-get update -y
apt-get install -y containerd.io
mkdir -p /etc/containerd
containerd config default | tee /etc/containerd/config.toml >/dev/null
# systemd cgroups + modern pause image
sed -i 's/^\\s*SystemdCgroup = false/\\tSystemdCgroup = true/' /etc/containerd/config.toml
sed -i 's|^\\(\\s*sandbox_image = \\).*|\\1"registry.k8s.io/pause:3.10"|' /etc/containerd/config.toml
systemctl enable --now containerd
systemctl restart containerd



# 4) Kernel modules + sysctl
cat >/etc/modules-load.d/k8s.conf <<'EOF'
overlay
br_netfilter
EOF
modprobe overlay || true
modprobe br_netfilter || true

cat >/etc/sysctl.d/99-kubernetes-cri.conf <<'EOF'
net.bridge.bridge-nf-call-iptables  = 1
net.ipv4.ip_forward                 = 1
net.bridge.bridge-nf-call-ip6tables = 1
EOF
sysctl --system >/dev/null

# 5) Kubernetes repo (VALID series)
K8S_SERIES="v1.31"
rm -f /etc/apt/sources.list.d/kubernetes.list
curl -fsSL "https://pkgs.k8s.io/core:/stable:/${"${K8S_SERIES}"}/deb/Release.key" \
  | gpg --dearmor --batch --yes -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg
chmod 0644 /etc/apt/keyrings/kubernetes-apt-keyring.gpg
cat >/etc/apt/sources.list.d/kubernetes.list <<EOF
deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/${"${K8S_SERIES}"}/deb/ /
EOF

apt-get update -y
apt-get install -y kubelet kubeadm kubectl
apt-mark hold kubelet kubeadm kubectl || true
`;

  // IMPORTANT: pass ONE string to bash -lc
  await sshExec(auth, host, sudoWrap(auth, script), "bootstrap");
}

async function kubeadmInit(
  auth: Auth,
  host: string,
  podCidr: string,
  kubeadmVersion?: string
) {
  const versionFlag =
    kubeadmVersion && /^\d+\.\d+\.\d+$/.test(kubeadmVersion)
      ? ` --kubernetes-version=${kubeadmVersion}`
      : "";

  const script = String.raw`
set -euxo pipefail
kubeadm init --pod-network-cidr=${podCidr}${versionFlag}

# kubeconfig for root
mkdir -p /root/.kube
install -m 600 /etc/kubernetes/admin.conf /root/.kube/config
chown root:root /root/.kube/config

# if invoked via sudo, also give invoking user a kubeconfig (unset-safe)
if [ -n "${"${SUDO_USER:-}"}" ]; then
  UHOME="$(getent passwd "${"${SUDO_USER}"}" | cut -d: -f6)"
  mkdir -p "$UHOME/.kube"
  install -m 600 /etc/kubernetes/admin.conf "$UHOME/.kube/config"
  chown "$(id -u "${"${SUDO_USER}"}")":"$(id -g "${"${SUDO_USER}"}")" "$UHOME/.kube/config"
fi
`;

  await sshExec(auth, host, sudoWrap(auth, script), "repair-api-server");
}

async function RepairApiServer(auth: Auth, host: string) {
  const script = String.raw`
 set -euxo pipefail
 # Align containerd with kubeadm expectations (idempotent)
sed -i 's|^\(\s*sandbox_image = \).*|\1"registry.k8s.io/pause:3.10"|' /etc/containerd/config.toml || true
sed -i 's/^\s*SystemdCgroup = false/\tSystemdCgroup = true/' /etc/containerd/config.toml || true
systemctl restart containerd
# Make sure net sysctls are set
cat >/etc/sysctl.d/99-kubernetes-cri.conf <<'EOF'
net.bridge.bridge-nf-call-iptables  = 1
net.ipv4.ip_forward                 = 1
net.bridge.bridge-nf-call-ip6tables = 1
EOF
sysctl --system >/dev/null
# Pre-pull control plane images (avoids pull delays)
kubeadm config images pull --kubernetes-version=stable-1.31 || true
# Restart kubelet to (re)create static pods
systemctl restart kubelet

# Wait for API to come up (<= ~5 min)
export KUBECONFIG=/etc/kubernetes/admin.conf
for i in {1..150}; do
  kubectl get --raw='/readyz?verbose' >/dev/null 2>&1 && echo "API READY" && break
  sleep 2
done

# Show status
kubectl get nodes -o wide || true
`;

  await sshExec(auth, host, sudoWrap(auth, script), "kubeadm-init");
}

// async function copyKubconfigToWorkers(apiHost: string, workers: NodeSpec[]) {
//   // Copy kubeconfig to each worker node
// }

async function installCalico(auth: Auth, host: string, calicoUrl: string) {
  await sshExec(
    auth,
    host,
    sudoWrap(auth, `kubectl apply -f ${calicoUrl}`),
    "calico"
  );
}

async function getJoinCommand(auth: Auth, host: string) {
  const cmd = await sshExec(
    auth,
    host,
    sudoWrap(auth, `kubeadm token create --print-join-command`),
    "join-token"
  );
  return `${cmd.trim()}`;
}

// async function joinWorker(auth: Auth, host: string, joinCmd: string) {
//   // await sshExec(auth, host, sudoWrap(auth, `set -eux; ${joinCmd}`), `join-${host}`);
//   await sshExec(auth, host, sudoWrap(auth, `    set -euo pipefail    ${joinCmd}
//  `), `join-${host}`);
// }

async function joinWorker(
  auth: Auth,
  host: string,
  apiHost: string,
  joinCmd: string
) {
  const script = `
set -euo pipefail

echo "== $(hostname) =="
echo "IP(s): $(hostname -I || true)"
echo "SSH_CONNECTION: $SSH_CONNECTION"

# Fail fast if API is not reachable from this worker
if ! (command -v nc >/dev/null 2>&1); then apt-get update -y && apt-get install -y netcat-openbsd >/dev/null 2>&1 || true; fi
if ! nc -vz ${apiHost} 6443 -w 3 >/dev/null 2>&1; then
  echo "ERROR: cannot reach ${apiHost}:6443 from $(hostname)"
  exit 12
fi

# Optional: wait until healthz returns ok (30*2s = 60s)
for i in $(seq 1 30); do
  if command -v curl >/dev/null 2>&1 && curl -sk --max-time 2 https://${apiHost}:6443/healthz | grep -q ok; then
    break
  fi
  sleep 2
done

echo "Running: ${joinCmd} --v=5"
${joinCmd} --v=5
`;
  await sshExec(auth, host, sudoWrap(auth, script), `join-${host}`);
}

async function fetchKubeconfig(auth: Auth, host: string, destPath: string) {
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await scpFrom(auth, host, "/etc/kubernetes/admin.conf", destPath);
}

// async function labelNode(auth: Auth, apiHost: string, nodeName: string, labels: Record<string, string>) {
//   const args = Object.entries(labels)
//     .map(([k, v]) => `${k}=${v}`)
//     .join(" ");
//   await sshExec(auth, apiHost, sudoWrap(auth, `kubectl label node ${nodeName} ${args} --overwrite`), `label-${nodeName}`);
// }

async function labelNode(
  auth: Auth,
  apiHost: string,
  nodeName: string,
  labels: Record<string, string>
) {
  const args = Object.entries(labels)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  await sshExec(
    auth,
    apiHost,
    sudoWrap(auth, `kubectl label node "${nodeName}" ${args} --overwrite`),
    "label-node"
  );
}

// async function waitForApi(auth: Auth, host: string) {
//   const s = `
// set -e
// for i in {1..90}; do
//   kubectl --kubeconfig=/etc/kubernetes/admin.conf get --raw='/readyz?verbose' >/dev/null 2>&1 && exit 0
//   sleep 2
// done
// echo "apiserver not ready" >&2
// exit 1
// `;
//   await sshExec(auth, host, sudoWrap(auth, s), "wait-api");
// }

async function waitForApi(auth: Auth, host: string, timeoutSec = 600) {
  const tries = Math.ceil(timeoutSec / 2);
  const script = `
set -e
export KUBECONFIG=/etc/kubernetes/admin.conf
for i in $(seq 1 ${tries}); do
  kubectl get --raw='/readyz?verbose' >/dev/null 2>&1 && exit 0
  sleep 2
done
echo "apiserver not ready after ${timeoutSec}s" >&2; exit 1
`;
  await sshExec(auth, host, sudoWrap(auth, script), "wait-api");
}

// copies /etc/kubernetes/admin.conf from cpHost to ~/.kube/config on each worker
async function pushKubeconfigToWorkers(
  auth: Auth,
  cpHost: string,
  workerHosts: string[]
) {
  const pwFlag =
    auth.method === "password"
      ? `sshpass -p '${auth.password.replace(/'/g, `'\\''`)}' `
      : "";
  const keyFlag = auth.method === "key" ? `-i ${auth.private_key_path}` : "";

  for (const w of workerHosts) {
    const script = `
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

# tools we need
if ! command -v scp >/dev/null 2>&1; then apt-get update -y && apt-get install -y openssh-client; fi
${
  auth.method === "password"
    ? `if ! command -v sshpass >/dev/null 2>&1; then apt-get update -y && apt-get install -y sshpass; fi`
    : ``
}

# ensure target dir
mkdir -p "\${HOME}/.kube"
chmod 700 "\${HOME}/.kube"

# try SCP; if it fails (permissions), fall back to ssh+sudo cat
if ${pwFlag}scp ${keyFlag} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  ${
    auth.user
  }@${cpHost}:/etc/kubernetes/admin.conf "\${HOME}/.kube/config"; then
  :
else
  echo "SCP failed, falling back to ssh+sudo cat..." >&2
  ${pwFlag}ssh ${keyFlag} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    ${
      auth.user
    }@${cpHost} "sudo cat /etc/kubernetes/admin.conf" > "\${HOME}/.kube/config"
fi

chmod 600 "\${HOME}/.kube/config"
chown \$(id -u):\$(id -g) "\${HOME}/.kube/config"
echo "Installed kubeconfig at \${HOME}/.kube/config"
`;
    await sshExec(auth, w, sudoWrap(auth, script), "kubefiles");
  }
}

// ---------- Processor ----------

const processor = async (job: Job) => {
  const data = job.data as JobData;
  const clusterId = data.clusterId;
  const podCidr = data.cluster.pod_cidr || POD_CIDR_DEFAULT;

  //   // Allow job to override the series if it provides k8s_minor
  const jobSeries = toSeries(data.cluster.k8s_minor ?? K8S_SERIES);
  const kubeadmVersion = toKubeadmVersion(
    jobSeries,
    undefined /* or allow pin via payload */
  );


  const nodes = Object.values(data.nodes);
  //console.log(nodes,"...................nodes");
  const cp = nodes.find((n) => n.role === "control-plane");
  if (!cp) throw new Error("No control-plane node provided.");
  const workers = nodes.filter((n) => n.role === "worker");

  await createClusterWorker({
    clusterId: clusterId,
    clusterName: job.data?.cluster?.name ?? `cluster-${job.id}`,
    controlPlane: job.data?.ips[0] ?? null,
    workers: job.data?.ips.slice(1) ?? [],
    nodeConfig: job.data?.nodeSpec ?? null,
    cniPlugin: job.data?.cni ?? "calico",
    k8sVersion: job.data?.k8sVersion ?? "1.31.1",
    status: "pending",
    //ownerId: job.data?.ownerId ?? null,
  });

  // Optionally set hostnames
  console.log("hostname set started");
  for (const n of nodes) {
    if (n.hostname) {
      const s = `
set -e
HN=${JSON.stringify(n.hostname)}
hostnamectl set-hostname -- "$HN"
if grep -qE '^127\\.0\\.1\\.1\\s' /etc/hosts; then
  sed -i "s/^127\\.0\\.1\\.1.*/127.0.1.1 $HN/" /etc/hosts
else
  echo "127.0.1.1 $HN" >> /etc/hosts
fi
`;
      await sshExec(data.auth, n.host, sudoWrap(data.auth, s), "set-hostname");

      console.log("hostname is set successful for -", n.hostname);
    }
  }
  console.log("hostname set ended");

  //   // Warn if sizing below requested
  console.log("sizing check  started");
  for (const n of nodes) {
    const info = await getHostInfo(data.auth, n.host);
    if (n.cpu && info.cpu < n.cpu)
      console.warn(
        `[warn] ${n.host} CPU present=${info.cpu} < target=${n.cpu}`
      );
    if (n.memory_mb && info.memory_mb < n.memory_mb)
      console.warn(
        `[warn] ${n.host} RAM present=${info.memory_mb}MB < target=${n.memory_mb}MB`
      );
  }
  console.log("sizing check  ended");

  //   //Bootstrap all nodes
  await Promise.all(
    nodes.map((n) => bootstrapNode(data.auth, n.host, jobSeries))
  );

  console.log("installed kubelet , kubecdm , kubeadm");

  //   // Init control-plane
  await kubeadmInit(data.auth, cp.host, podCidr, kubeadmVersion);
  console.log("initialized kubeadm success");

  await waitForApi(data.auth, cp.host);
  console.log("waiting for api call over");

  // CNI
  await installCalico(data.auth, cp.host, CALICO_URL);
  console.log("install_Calico success");

  // Join workers or enable master scheduling
  if (workers.length) {
    const joinCmd = await getJoinCommand(data.auth, cp.host);
    for (const w of workers) {
      await joinWorker(data.auth, w.host, cp.host, joinCmd);
    }
  } else {
    //Single-node: allow workloads on control-plane
    console.log("allow workloads on control-plane");
    await sshExec(
      data.auth,
      cp.host,
      sudoWrap(
        data.auth,
        `kubectl --kubeconfig=/etc/kubernetes/admin.conf taint nodes --all node-role.kubernetes.io/control-plane- || true`
      ),
      "cp-sched"
    );
    //after kubeadm init + API ready + (optional) calico:
    const untaint = `
set -euo pipefail
export KUBECONFIG=/etc/kubernetes/admin.conf
HN="$(hostnamectl --static 2>/dev/null || hostname)"
# remove both possible keys; trailing '-' means "remove"
kubectl taint nodes -l "kubernetes.io/hostname=${"${HN}"}" node-role.kubernetes.io/control-plane- || true
kubectl taint nodes -l "kubernetes.io/hostname=${"${HN}"}" node-role.kubernetes.io/master- || true
`;
    await sshExec(data.auth, cp.host, sudoWrap(data.auth, untaint), "untaint");
  }

  // Fetch kubeconfig
  const kubePath = path.join(KUBECONFIG_DIR, `${clusterId}.yaml`);

  await updateClusterPhaseWorker({
    clusterId: clusterId as string,
    phase: "create",
    value: true,
    status: "creating",
  });
  await fetchKubeconfig(data.auth, cp.host, kubePath);

  await updateClusterPhaseWorker({
    clusterId: clusterId as string,
    phase: "connect",
    value: true,
    status: "ready",
  });

  //If API server are exited or missing  apply these  safe repairs
  console.log("RepairApiServer started");

  await RepairApiServer(data.auth, cp.host);
  await updateClusterPhaseWorker({
    clusterId: clusterId as string,
    phase: "verify",
    value: true,
    status: "ready",
  });
  console.log("RepairApiServer success");

  // await pushKubeconfigToWorkers(data.auth,cp.host,job.data.ips.slice(1));
  console.log("copyKubconfigToWorkers success");

  //console.log("fetchKubeconfig success");

  console.log("reached here");
  const check = await updateVmByIps(job.data.ips);
  console.log(check, "updateVmByIps success");

  // Optional labels
  // const cpInfo = await getHostInfo(data.auth, cp.host);
  // await labelNode(data.auth, cp.host, cpInfo.hostname, {
  //   "ahura.cloud/cluster": data.cluster.name,
  //   "topology.kubernetes.io/region": data.cluster.location,
  // });
  //console.log(cpInfo,"................host info fetch success");
  //   await labelNode(data.auth, cp.host, /* nodeName */ cpInfo.hostname, {
  //   "ahura.cloud/cluster": data.cluster.name,
  //   "topology.kubernetes.io/region": data.cluster.location,
  // });

  // for (const w of workers) {
  //   const wInfo = await getHostInfo(data.auth, w.host);
  //   await labelNode(data.auth, cp.host, wInfo.hostname, {
  //     "ahura.cloud/cluster": data.cluster.name,
  //     "topology.kubernetes.io/region": data.cluster.location,
  //   });
  // }

  const buf = await fs.readFile(kubePath);
   await updateClusterWorker({
    clusterId: clusterId as string,
    kubeConfig: buf as Buffer,
  });
 // const sha256 = crypto.createHash("sha256").update(buf).digest("hex");

 // console.log("kubecofig.......",kubePath,".........kubecofig file buf :", buf, ".....sha256:", sha256);

   return { ok: true, kubeconfigPath: kubePath, controlPlane: cp.host, nodes: data.nodes };
};

// ---------- Start worker ----------
const worker = new Worker(QUEUE_NAME, processor, {
  connection,
  concurrency: 1,
});
worker.on("ready", () => console.log(`[worker] ready on ${QUEUE_NAME}`));
worker.on("active", (job: any) => console.log(`[worker] active ${job.id}`));
worker.on("completed", (job: any, res: any) =>
  console.log(`[worker] completed ${job.id}`, res)
);
worker.on("failed", (job: any, err: any) =>
  console.error(`[worker] failed ${job?.id}`, err?.stack || err)
);
worker.on("error", (err: any) => console.error("[worker] runtime error", err));
