{{- define "learning-lab.labels" -}}
app.kubernetes.io/part-of: learning-lab
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/* Rolls the pods that read the Secret when its contents change. */}}
{{- define "learning-lab.secretChecksum" -}}
{{ printf "%s\n%s" .Values.convexUrl .Values.runnerSecret | sha256sum | quote }}
{{- end }}
