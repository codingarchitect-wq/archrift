package api

import (
	"net/http"

	"example.com/shop/order"
	"github.com/gin-gonic/gin"
)

type Handler struct {
	service *order.Service
}

func NewHandler(service *order.Service) *Handler {
	return &Handler{service: service}
}

// GetOrder serves one order.
func (h *Handler) GetOrder(c *gin.Context) {
	found, err := h.service.Find(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, found)
}

// Register adds the routes under /v1.
func Register(router *gin.Engine, h *Handler) {
	v1 := router.Group("/v1")
	v1.GET("/orders/:id", h.GetOrder)
	v1.POST("/orders", func(c *gin.Context) { c.Status(http.StatusAccepted) })
}

// Health answers the liveness probe.
func Health(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
}
