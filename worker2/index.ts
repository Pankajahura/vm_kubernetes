import "dotenv/config";
import { Worker, Job } from "bullmq";
import IORedis from "ioredis";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

// ---------- ENV ----------
const REDIS_URL = process.env.REDIS_URL!;
const QUEUE_NAME = process.env.QUEUE_NAME || "provision-queue";
const POD_CIDR_DEFAULT = process.env.POD_CIDR || "10.244.0.0/16";
const K8S_MINOR_DEFAULT = process.env.K8S_MINOR || 1.31;
const KUBECONFIG_DIR = process.env.KUBECONFIG_DIR || "/srv/kubeconfigs";
const CALICO_URL = process.env.CALICO_URL ||
  "https://raw.githubusercontent.com/projectcalico/calico/v3.28.0/manifests/calico.yaml";

// ---------- Types ----------
type Role = "control-plane" | "worker";
type Auth =
  | { method: "password"; user: string; password: string }
  | { method: "key"; user: string; private_key_path: string };

type NodeSpec = { host: string; role: Role; hostname?: string; cpu?: number; memory_mb?: number };
type JobData = {
  clusterId: string;
  provider: "existing";
  cluster: { name: string; location: string; pod_cidr?: string; k8s_minor?: string };
  auth: Auth;
  nodes: Record<string, NodeSpec>;
};

// ---------- Redis ----------
const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });

// ---------- SSH helpers ----------
function sshBaseArgs(auth: Auth, host: string) {
  const common = [
    "-o", "StrictHostKeyChecking=no",
    "-o", "PreferredAuthentications=keyboard-interactive,password"
  ];
  const dest = `${auth.user}@${host}`;
  if (auth.method === "password") {
    return {
      bin: "sshpass",
      args: ["-p", auth.password, "ssh", ...common,
        "-o", "PreferredAuthentications=password", "-o", "PubkeyAuthentication=no", dest]
    };
  } else {
    return { bin: "ssh", args: ["-i", auth.private_key_path, ...common, dest] };
  }
}

async function sshExec(auth: Auth, host: string, cmd: string, label?: string) {
  const { bin, args } = sshBaseArgs(auth, host);
  const all = [...args, "bash", "-lc",sudoWrap(auth, `hostnamectl set-hostname root`), cmd];
  const { stdout, stderr } = await execFileAsync(bin, all, { encoding: "utf8" });
  if (stderr?.trim()) console.warn(`[ssh:${label ?? host} stderr]`, stderr.trim());
  return stdout.trim();
}

async function scpFrom(auth: Auth, host: string, remote: string, local: string) {
  await fs.mkdir(path.dirname(local), { recursive: true });
  if (auth.method === "password") {
    const args = [
      "-p", auth.password, "scp",
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      `${auth.user}@${host}:${remote}`, local
    ];
    await execFileAsync("sshpass", args);
  } else {
    const args = [
      "-i", auth.private_key_path,
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      `${auth.user}@${host}:${remote}`, local
    ];
    await execFileAsync("scp", args);
  }
}

async function getHostInfo(auth: Auth, host: string) {
  const out = await sshExec(auth, host,
`set -e
HN=$(hostnamectl --static 2>/dev/null || hostname)
CPU=$(nproc)
MEM=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
echo "$HN $CPU $MEM"`);
  const [hostname, cpuStr, memStr] = out.split(/\s+/);
  return { hostname, cpu: Number(cpuStr), memory_mb: Number(memStr) };
}

// wrap commands that need sudo (if user is not root)
function sudoWrap(auth: Auth, raw: string) {
  // root user: no sudo needed
  if (auth.user === "root") return raw;
  
  const inner = `bash -lc ${JSON.stringify(raw)}`;
  if (auth.method === "password") {
    const pw = (auth.password).replace(/'/g, `'\\''`);
    return `set -e; echo '${pw}' | sudo -S -p '' ${inner}`;
  }

  // most cloud images have passwordless sudo for 'ubuntu' (NOPASSWD), so plain sudo works.
  // If your user requires a sudo password, enable the next line by piping the password:
  // return `set -e; echo '${(auth as any).password ?? ""}' | sudo -S -p '' bash -lc ${JSON.stringify(raw)}`;
  //return `sudo bash -lc ${JSON.stringify(raw)}`;
	 return `sudo ${inner}`;
}

// ---------- Provision steps ----------
async function bootstrapNode(auth: Auth, host: string, k8sMinor: string) {
  await sshExec(auth, host, sudoWrap(auth,
`set -eux
swapoff -a || true
sed -i.bak '/\\sswap\\s/d' /etc/fstab || true

if ! command -v containerd >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg lsb-release
  install -m 0755 -d /etc/apt/keyrings || true
  rm -f /etc/apt/keyrings/docker.gpg || true
  curl -fsSL https://download.docker.com/linux/$(. /etc/os-release; echo "$ID")/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$(. /etc/os-release; echo "$ID") $(. /etc/os-release; echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y containerd.io
  mkdir -p /etc/containerd
  containerd config default | tee /etc/containerd/config.toml >/dev/null
  systemctl enable --now containerd
fi

if ! command -v kubeadm >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y apt-transport-https ca-certificates curl gpg
  mkdir -p -m 755 /etc/apt/keyrings
  curl -fsSL https://pkgs.k8s.io/core:/stable:/${k8sMinor}/deb/Release.key | gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg
  echo "deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/${k8sMinor}/deb/ /" > /etc/apt/sources.list.d/kubernetes.list
  apt-get update -y
  apt-get install -y kubelet kubeadm kubectl
  apt-mark hold kubelet kubeadm kubectl
fi

cat <<'SYS' > /etc/sysctl.d/99-kubernetes-cri.conf
net.bridge.bridge-nf-call-iptables  = 1
net.ipv4.ip_forward                 = 1
net.bridge.bridge-nf-call-ip6tables = 1
SYS
sysctl --system >/dev/null
`));
}

async function kubeadmInit(auth: Auth, host: string, podCidr: string, k8sMinor: string) {
  await sshExec(auth, host, sudoWrap(auth,
`set -eux
kubeadm init --pod-network-cidr=${podCidr} --kubernetes-version=${k8sMinor}
mkdir -p /root/.kube
cp -f /etc/kubernetes/admin.conf /root/.kube/config
chown root:root /root/.kube/config
# also give the SSH user a kubeconfig for convenience (if not root)
if [ "$SUDO_USER" != "" ]; then
  UHOME=$(getent passwd "$SUDO_USER" | cut -d: -f6)
  mkdir -p "$UHOME/.kube"
  cp -f /etc/kubernetes/admin.conf "$UHOME/.kube/config"
  chown $(id -u "$SUDO_USER"):$(id -g "$SUDO_USER") "$UHOME/.kube/config"
fi
`));
}

async function installCalico(auth: Auth, host: string, calicoUrl: string) {
  await sshExec(auth, host, sudoWrap(auth, `kubectl apply -f ${calicoUrl}`));
}

async function getJoinCommand(auth: Auth, host: string) {
  const cmd = await sshExec(auth, host, sudoWrap(auth, `kubeadm token create --print-join-command`));
  return `sudo ${cmd.trim()}`;
}

async function joinWorker(auth: Auth, host: string, joinCmd: string) {
  await sshExec(auth, host, sudoWrap(auth, `set -eux; ${joinCmd}`));
}

async function fetchKubeconfig(auth: Auth, host: string, dest: string) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await scpFrom(auth, host, "/etc/kubernetes/admin.conf", dest);
}

async function labelNode(auth: Auth, apiHost: string, nodeName: string, labels: Record<string,string>) {
  const args = Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(" ");
  await sshExec(auth, apiHost, sudoWrap(auth, `kubectl label node ${nodeName} ${args} --overwrite`));
}

// ---------- Processor ----------
const processor = async (job: Job) => {
  const data = job.data as JobData;
  const clusterId = data.clusterId;
  const podCidr = data.cluster.pod_cidr || POD_CIDR_DEFAULT;
  const k8sMinor = data.cluster.k8s_minor || K8S_MINOR_DEFAULT;

  console.log("[job] starting", { id: job.id, clusterId, nodes: Object.keys(data.nodes).length });

  const nodes = Object.values(data.nodes);
  const cp = nodes.find(n => n.role === "control-plane");
  if (!cp) throw new Error("No control-plane node provided.");
  const workers = nodes.filter(n => n.role === "worker");

  // optional hostname set
  for (const n of nodes) {
    if (n.hostname) {
      await sshExec(data.auth, n.host, sudoWrap(data.auth, `hostnamectl set-hostname ${n.hostname}`), n.host);
    }
  }

  // validate sizing (warn only)
  for (const n of nodes) {
    const info = await getHostInfo(data.auth, n.host);
    if (n.cpu && info.cpu < n.cpu) console.warn(`[warn] ${n.host} CPU present=${info.cpu} < target=${n.cpu}`);
    if (n.memory_mb && info.memory_mb < n.memory_mb) console.warn(`[warn] ${n.host} RAM present=${info.memory_mb}MB < target=${n.memory_mb}MB`);
  }

  // bootstrap all
  await Promise.all(nodes.map(n => bootstrapNode(data.auth, n.host, k8sMinor)));

  // init control plane
  await kubeadmInit(data.auth, cp.host, podCidr, k8sMinor);

  // CNI
  await installCalico(data.auth, cp.host, CALICO_URL);

  // join workers
  const joinCmd = await getJoinCommand(data.auth, cp.host);
  for (const w of workers) await joinWorker(data.auth, w.host, joinCmd);

  // fetch kubeconfig
  const kubePath = path.join(KUBECONFIG_DIR, `${clusterId}.yaml`);
  await fetchKubeconfig(data.auth, cp.host, kubePath);

  // labels
  const cpInfo = await getHostInfo(data.auth, cp.host);
  await labelNode(data.auth, cp.host, cpInfo.hostname, {
    "ahura.cloud/cluster": data.cluster.name,
    "topology.kubernetes.io/region": data.cluster.location
  });
  for (const w of workers) {
    const wInfo = await getHostInfo(data.auth, w.host);
    await labelNode(data.auth, cp.host, wInfo.hostname, {
      "ahura.cloud/cluster": data.cluster.name,
      "topology.kubernetes.io/region": data.cluster.location
    });
  }

  return { ok: true, kubeconfigPath: kubePath, controlPlane: cp.host, nodes: data.nodes };
};

// ---------- Start worker ----------
const worker = new Worker(QUEUE_NAME, processor, { connection, concurrency: 1 });
worker.on("ready", () => console.log(`[worker] ready on ${QUEUE_NAME}`));
worker.on("active", (job) => console.log(`[worker] active ${job.id}`));
worker.on("completed", (job, res) => console.log(`[worker] completed ${job.id}`, res));
worker.on("failed", (job, err) => console.error(`[worker] failed ${job?.id}`, err?.stack || err));
worker.on("error", (err) => console.error("[worker] runtime error", err));
