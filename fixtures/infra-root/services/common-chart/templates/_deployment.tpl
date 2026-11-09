{{/*
The deployment every service runs.
*/}}
{{- define "common.deployment" -}}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Chart.Name }}
  labels:
    {{- include "common.labels" . | nindent 4 }}
spec:
  replicas: {{ .Values.replicas }}
  template:
    metadata:
      labels:
        app: {{ .Chart.Name }}
    spec:
      serviceAccountName: backend-sa
      containers:
        - name: {{ .Chart.Name }}
          image: registry.example.com/{{ .Values.imageName }}:{{ .Chart.Version }}
          {{- if .Values.container.port }}
          ports:
            - containerPort: {{ .Values.container.port }}
          {{- end }}
          envFrom:
            - configMapRef:
                name: "{{ .Chart.Name }}-config"
{{- end -}}
