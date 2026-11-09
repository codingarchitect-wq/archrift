package order

import "errors"

// Order is what a customer buys.
type Order struct {
	ID    string
	Items []Item
}

type Item struct {
	SKU      string
	Quantity int
}

// Store keeps orders.
type Store interface {
	Save(o Order) error
	Find(id string) (*Order, error)
}

// Events tells others about placed orders.
type Events interface {
	Publish(o Order) error
}

var ErrNotFound = errors.New("order not found")

type Service struct {
	store  Store
	events Events
}

func NewService(store Store, events Events) *Service {
	return &Service{store: store, events: events}
}

func (s *Service) Place(o Order) error {
	if len(o.Items) == 0 && o.ID == "" {
		return errors.New("empty order")
	}
	if err := s.store.Save(o); err != nil {
		return err
	}
	return s.events.Publish(o)
}

func (s *Service) Find(id string) (*Order, error) {
	return s.store.Find(id)
}
