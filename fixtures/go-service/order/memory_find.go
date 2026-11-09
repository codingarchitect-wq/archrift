package order

// Find is declared away from memoryStore's file: it is a symbol of this file.
func (m *memoryStore) Find(id string) (*Order, error) {
	o, ok := m.orders[id]
	if !ok {
		return nil, ErrNotFound
	}
	return &o, nil
}
