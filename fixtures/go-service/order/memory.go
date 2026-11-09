package order

type memoryStore struct {
	base
	orders map[string]Order
}

func NewMemoryStore() *memoryStore {
	return &memoryStore{orders: map[string]Order{}}
}

func (m *memoryStore) Save(o Order) error {
	m.orders[o.ID] = o
	m.touch()
	return nil
}
