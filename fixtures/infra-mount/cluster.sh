#!/bin/bash
# What every service's pods share: their service account.
set -e

cat <<EOF2 | kubectl apply -f -
apiVersion: v1
kind: ServiceAccount
metadata:
  name: backend-sa
  namespace: $NAMESPACE
EOF2
