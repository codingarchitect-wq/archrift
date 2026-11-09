package messaging

import (
	"context"

	"example.com/shop/config"
	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
)

// DeadLetterTopic receives the orders that could not be placed.
const DeadLetterTopic = "shop.orders.dlq"

// CreateTopics creates the topics when the configuration asks for it (locally).
func CreateTopics(configuration config.Configuration) {
	if !configuration.Kafka.Topic.AutoCreate {
		return
	}
	shipped := configuration.Kafka.Topic.Shipped
	specs := []kafka.TopicSpecification{
		{Topic: shipped.Name, NumPartitions: shipped.Partitions},
		{Topic: DeadLetterTopic, NumPartitions: 1},
	}
	client, err := kafka.NewAdminClient(&kafka.ConfigMap{"bootstrap.servers": configuration.Kafka.Broker})
	if err != nil {
		panic(err)
	}
	_, _ = client.CreateTopics(context.Background(), specs)
}
