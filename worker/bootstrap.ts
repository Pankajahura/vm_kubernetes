// bootstrap.ts
import { sshExec } from "./ssh";
import "dotenv/config";
import * as fs from "node:fs/promises";
import * as path from "node:path";

function sh(script: string) {
  // Wrap multi-line script safely for remote bash -lc
  return `bash -lc '${script.replace(/'/g, `'\\''`)}'`;
}

export async function bootstrapNode(
  host: string,
  user: string,
  key: string,
  k8sMinor: string
) {
  const script = `
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

# 1) disable swap
sudo swapoff -a || true
sudo sed -i '/[[:space:]]swap[[:space:]]/ s/^/#/' /etc/fstab || true

# 2) kernel + sysctl
cat <<'EOF' | sudo tee /etc/modules-load.d/containerd.conf
overlay
br_netfilter
EOF
sudo modprobe overlay || true
sudo modprobe br_netfilter || true

cat <<'EOF' | sudo tee /etc/sysctl.d/99-kubernetes-cri.conf
net.bridge.bridge-nf-call-iptables  = 1
net.bridge.bridge-nf-call-ip6tables = 1
net.ipv4.ip_forward                 = 1
EOF
sudo sysctl --system

# 3) containerd
sudo apt-get update -y
sudo apt-get install -y containerd ca-certificates curl gpg apt-transport-https
sudo mkdir -p /etc/containerd
containerd config default | sudo tee /etc/containerd/config.toml >/dev/null
sudo sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' /etc/containerd/config.toml
sudo systemctl enable --now containerd

# 4) kube tools from pkgs.k8s.io
sudo mkdir -p -m 755 /etc/apt/keyrings
curl -fsSL https://pkgs.k8s.io/core:/stable:/${k8sMinor}/deb/Release.key | sudo gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg
echo "deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/${k8sMinor}/deb/ /" | sudo tee /etc/apt/sources.list.d/kubernetes.list
sudo apt-get update -y
sudo apt-get install -y kubelet kubeadm kubectl
sudo apt-mark hold kubelet kubeadm kubectl
`;
  await sshExec(sh(script), { user, host, key, timeoutMs: 10 * 60_000 });
}

export async function kubeadmInit(
  host: string,
  user: string,
  key: string,
  podCidr: string
) {
  // kubeadm init (run as root via sudo)
  await sshExec(`sudo kubeadm init --pod-network-cidr=${podCidr} --upload-certs`, {
    user,
    host,
    key,
    timeoutMs: 10 * 60_000,
  });

  // set up kubectl for the remote (non-root) user
  const setupKubectl = `
mkdir -p $HOME/.kube
sudo cp -i /etc/kubernetes/admin.conf $HOME/.kube/config
sudo chown $(id -u):$(id -g) $HOME/.kube/config
`;
  await sshExec(sh(setupKubectl), { user, host, key, timeoutMs: 60_000 });
}

export async function installCalico(host: string, user: string, key: string) {
  const calico = `
kubectl apply -f https://raw.githubusercontent.com/projectcalico/calico/v3.30.3/manifests/calico.yaml
`;
  await sshExec(sh(calico), { user, host, key, timeoutMs: 3 * 60_000 });
}

export async function enableControlPlaneScheduling(host: string, user: string, key: string) {
  const script = `
set -euxo pipefail
N=$(kubectl get nodes -o jsonpath='{.items[0].metadata.name}')
kubectl taint nodes "$N" node-role.kubernetes.io/control-plane- || true
kubectl taint nodes "$N" node-role.kubernetes.io/master- || true
kubectl label nodes "$N" node-role.kubernetes.io/worker="" --overwrite || true
`;
  await sshExec(`bash -lc '${script.replace(/'/g, `'\\''`)}'`, { user, host, key, timeoutMs: 60_000 });
}

export async function getJoinCommand(host: string, user: string, key: string) {
  const { stdout } = await sshExec(
    `sudo kubeadm token create --print-join-command`,
    { user, host, key, timeoutMs: 60_000 }
  );
  const text = stdout.trim();
  const join =
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("kubeadm join")) ?? text;

  if (!join.includes("kubeadm join")) {
    throw new Error(`Unexpected kubeadm output while getting join command: ${text}`);
  }
  return join;
}

export async function joinWorker(
  host: string,
  user: string,
  key: string,
  joinCmd: string
) {
  await sshExec(`sudo ${joinCmd}`, { user, host, key, timeoutMs: 5 * 60_000 });
}

export async function fetchKubeconfig(
  host: string,
  user: string,
  key: string,
  destPath: string
) {
  const { stdout } = await sshExec("sudo cat /etc/kubernetes/admin.conf", {
    user,
    host,
    key,
    timeoutMs: 120_000,
  });
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await fs.writeFile(destPath, stdout, { mode: 0o600 });
}


//promithus - graphana.
//real time feature in supabase 