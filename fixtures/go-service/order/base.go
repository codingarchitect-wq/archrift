package order

// base counts writes; stores embed it.
type base struct {
	writes int
}

func (b *base) touch() {
	b.writes++
}

func (b *base) Writes() int {
	return b.writes
}
