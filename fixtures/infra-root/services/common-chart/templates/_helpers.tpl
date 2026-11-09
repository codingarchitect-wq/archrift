{{- define "common.labels" -}}
app: {{ .Chart.Name }}
version: {{ .Chart.Version | quote }}
{{- end -}}
