{{- define "learning-lab.labels" -}}
app.kubernetes.io/part-of: learning-lab
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/* nodeSelector pinning a pod to .Values.nodeArch (dev: amd64-only images); nothing when empty. */}}
{{- define "learning-lab.nodeSelector" -}}
{{- if .Values.nodeArch -}}
nodeSelector:
  kubernetes.io/arch: {{ .Values.nodeArch | quote }}
{{- end }}
{{- end }}

{{/* Rolls the pods that read the Secret when its contents change. */}}
{{- define "learning-lab.secretChecksum" -}}
{{ printf "%s\n%s" .Values.convexUrl .Values.runnerSecret | sha256sum | quote }}
{{- end }}
