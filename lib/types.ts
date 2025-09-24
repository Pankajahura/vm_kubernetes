// types.ts
export type CreateClusterInput = {
  clusterId: string;
  clusterName: string;

  controlPlane?: string | null;        // e.g., API VIP or CP-1 IP
  workers?: string[];                  // list of worker IPs/hosts
  createStatus?: boolean;
  connectStatus?: boolean;
  verifyStatus?: boolean;

  kubeConfig?: string | null;          // kubeconfig YAML
  nodeConfig?: Record<string, any> | null; // {region, plan, cpu, ram, disk ...}

  cniPlugin?: 'flannel' | 'calico' | 'cilium' | string | null;
  k8sVersion?: string | null;

  status?: 'pending' | 'creating' | 'ready' | 'failed' | 'deleted';
  ownerId?: string | null;             // link to auth.users.id if you use RLS
};
