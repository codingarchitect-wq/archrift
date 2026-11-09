package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHealth(t *testing.T) {
	request, _ := http.NewRequest(http.MethodGet, "/health", nil)
	recorder := httptest.NewRecorder()
	Health(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatal(recorder.Code)
	}
}
