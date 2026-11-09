#!/bin/bash
# Creates the topics of an environment.
ENV="$1"

create_compacted() {
  kafka-topics.sh --bootstrap-server 127.0.0.1:9092 \
    --topic "$1" \
    --config cleanup.policy=compact \
    --create
}

kafka-topics.sh --create --topic acme.$ENV.orders.v1 \
    --bootstrap-server 127.0.0.1:9092 \
    --partitions 3
# kafka-topics.sh --create --topic acme.$ENV.retired
kafka-acls.sh --add --allow-principal User:orders --topic acme.$ENV.orders.v1
create_compacted "acme.$ENV.customers"
