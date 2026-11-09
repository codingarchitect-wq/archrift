package main

import (
	"net/http"
	_ "net/http/pprof"

	"example.com/shop/api"
	"example.com/shop/config"
	"example.com/shop/messaging"
	orders "example.com/shop/order"
	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/gin-gonic/gin"
)

func main() {
	configuration := config.NewConfiguration()
	messaging.CreateTopics(configuration)

	producer, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": configuration.Kafka.Broker})
	if err != nil {
		panic(err)
	}
	publisher := messaging.NewPublisher(producer, configuration.Kafka.Topic.Shipped.Name)
	store := orders.NewMemoryStore()
	service := orders.NewService(store, publisher)

	go messaging.Listen(configuration.Kafka, service)

	router := gin.New()
	api.Register(router, api.NewHandler(service))
	http.HandleFunc("/health", api.Health)
	_ = router.Run(":8080")
}
