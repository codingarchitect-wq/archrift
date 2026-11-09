package config

// Configuration is read from resources/application*.yml.
type Configuration struct {
	Kafka  KafkaProperties
	Server ServerProperties
}

type KafkaProperties struct {
	Broker string
	Topic  TopicsProperties
}

type TopicsProperties struct {
	AutoCreate bool
	Orders     TopicProperties
	Shipped    TopicProperties
}

type TopicProperties struct {
	Name       string `validate:"required"`
	Partitions int
}

type ServerProperties struct {
	Port int
}

func NewConfiguration() Configuration {
	return Configuration{Server: ServerProperties{Port: 8080}}
}
