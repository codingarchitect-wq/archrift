package messaging

import (
	"example.com/shop/config"
	"example.com/shop/order"
	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
)

// Listen places the orders that arrive on the orders topic.
func Listen(props config.KafkaProperties, service *order.Service) {
	consumer, err := kafka.NewConsumer(&kafka.ConfigMap{"bootstrap.servers": props.Broker, "group.id": "shop"})
	if err != nil {
		panic(err)
	}
	if err := consumer.SubscribeTopics([]string{props.Topic.Orders.Name}, nil); err != nil {
		panic(err)
	}
	for {
		msg, err := consumer.ReadMessage(-1)
		if err == nil {
			_ = service.Place(order.Order{ID: string(msg.Key)})
		}
	}
}
