package order

import "testing"

type recorder struct{ published []Order }

func (r *recorder) Publish(o Order) error {
	r.published = append(r.published, o)
	return nil
}

func TestPlace(t *testing.T) {
	store := NewMemoryStore()
	events := &recorder{}
	service := NewService(store, events)
	if err := service.Place(Order{ID: "1", Items: []Item{{SKU: "a", Quantity: 1}}}); err != nil {
		t.Fatal(err)
	}
	if store.Writes() != 1 || len(events.published) != 1 {
		t.Fatal("not stored")
	}
}
