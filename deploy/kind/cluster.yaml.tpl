# Rendered by scripts/cluster.mjs (scenarios path is machine-specific).
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
name: learning-lab
nodes:
  - role: control-plane
    extraMounts:
      - hostPath: __SCENARIOS_PATH__
        containerPath: /scenarios
        readOnly: true
    extraPortMappings:
      - containerPort: 30080
        hostPort: 8080
        listenAddress: 127.0.0.1
        protocol: TCP
