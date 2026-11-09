{{- define "common.service" -}}
apiVersion: v1
kind: Service
metadata:
  name: {{ .Chart.Name }}
spec:
  selector:
    app: {{ .Chart.Name }}
  ports:
    - port: {{ .Values.container.port }}
{{- end -}}
