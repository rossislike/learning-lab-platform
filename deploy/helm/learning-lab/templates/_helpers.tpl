{{- define "learning-lab.labels" -}}
app.kubernetes.io/part-of: learning-lab
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
