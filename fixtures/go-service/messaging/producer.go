package messaging

import (
	"example.com/shop/order"
	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
)

// Publisher sends placed orders to a topic; it implements order.Events.
type Publisher struct {
	producer *kafka.Producer
	topic    string
}

func NewPublisher(producer *kafka.Producer, topic string) *Publisher {
	return &Publisher{producer: producer, topic: topic}
}

func (p *Publisher) Publish(o order.Order) error {
	return p.producer.Produce(&kafka.Message{
		TopicPartition: kafka.TopicPartition{Topic: &p.topic, Partition: kafka.PartitionAny},
		Value:          []byte(o.ID),
	}, nil)
}
