package order_test

import (
	"testing"

	. "example.com/shop/order"
)

func TestFind(t *testing.T) {
	service := NewService(NewMemoryStore(), nil)
	if _, err := service.Find("missing"); err != ErrNotFound {
		t.Fatal(err)
	}
}
