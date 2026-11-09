#!/bin/bash
# Brings the platform up: topics, databases, the broker's chart.
set -e
source ./lib.sh
ENV="$1"

cd kafka
./create-topics.sh "$ENV"
cd ../mysql
./create-databases.sh "$ENV"
cd ..

log "installing kafka"
helm install kafka oci://registry.example.com/charts/kafka \
  --namespace kafka \
  --values ./values/kafka-values.yaml
kubectl apply -f "$(dirname "$0")/mongodb/mongodb-values.yaml" --dry-run=client
