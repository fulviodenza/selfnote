#!/usr/bin/env bash
# Selfnote backup restore drill.
#
# A backup you have never restored is not a backup. This script proves the
# CloudNativePG backup → object-storage → restore path end to end:
#   1. write a known marker row into the live database
#   2. take an on-demand base backup (WAL archiving is already continuous)
#   3. bootstrap a NEW cluster by recovery from that backup
#   4. verify the marker row is present in the recovered cluster
#
# Run it against an installed Selfnote release on a cluster where CloudNativePG
# and the object store (MinIO) are up.
#
# Usage: NAMESPACE=selfnote RELEASE=sn ./deploy/restore-drill.sh
set -euo pipefail

NAMESPACE="${NAMESPACE:-selfnote}"
RELEASE="${RELEASE:-sn}"
CLUSTER="${RELEASE}-selfnote-pg"
RECOVERY="${CLUSTER}-restore"
MARKER="restore-drill-$(date +%s)"

kexec() { kubectl -n "$NAMESPACE" exec "$1" -- "${@:2}"; }
psql_primary() {
  local primary
  primary=$(kubectl -n "$NAMESPACE" get pods -l "cnpg.io/cluster=$CLUSTER,role=primary" -o jsonpath='{.items[0].metadata.name}')
  kexec "$primary" psql -U postgres -d selfnote -tAc "$1"
}

echo "==> 1. Writing marker row ($MARKER)"
psql_primary "create table if not exists restore_drill (id text primary key);"
psql_primary "insert into restore_drill (id) values ('$MARKER');"

echo "==> 2. Taking on-demand backup"
cat <<EOF | kubectl -n "$NAMESPACE" apply -f -
apiVersion: postgresql.cnpg.io/v1
kind: Backup
metadata:
  name: drill-backup-$(date +%s)
spec:
  cluster:
    name: $CLUSTER
EOF

echo "    waiting for a completed backup..."
for _ in $(seq 1 60); do
  phase=$(kubectl -n "$NAMESPACE" get backup -o jsonpath='{range .items[*]}{.status.phase}{"\n"}{end}' | grep -c completed || true)
  [ "$phase" -ge 1 ] && break
  sleep 5
done

echo "==> 3. Bootstrapping recovery cluster $RECOVERY from backup"
cat <<EOF | kubectl -n "$NAMESPACE" apply -f -
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: $RECOVERY
spec:
  instances: 1
  storage:
    size: 5Gi
  bootstrap:
    recovery:
      source: $CLUSTER
  externalClusters:
    - name: $CLUSTER
      barmanObjectStore:
        destinationPath: s3://selfnote-backups/pg
        endpointURL: http://${RELEASE}-minio:9000
        s3Credentials:
          accessKeyId:
            name: ${RELEASE}-minio
            key: ACCESS_KEY_ID
          secretAccessKey:
            name: ${RELEASE}-minio
            key: ACCESS_SECRET_KEY
EOF

echo "    waiting for recovery cluster to be ready..."
kubectl -n "$NAMESPACE" wait --for=condition=Ready "cluster/$RECOVERY" --timeout=600s

echo "==> 4. Verifying marker row in recovered cluster"
primary=$(kubectl -n "$NAMESPACE" get pods -l "cnpg.io/cluster=$RECOVERY,role=primary" -o jsonpath='{.items[0].metadata.name}')
found=$(kubectl -n "$NAMESPACE" exec "$primary" -- psql -U postgres -d selfnote -tAc \
  "select count(*) from restore_drill where id='$MARKER';")

if [ "$found" = "1" ]; then
  echo "RESTORE DRILL PASSED — marker '$MARKER' recovered."
  echo "Clean up with: kubectl -n $NAMESPACE delete cluster $RECOVERY"
  exit 0
else
  echo "RESTORE DRILL FAILED — marker not found in recovered cluster."
  exit 1
fi
