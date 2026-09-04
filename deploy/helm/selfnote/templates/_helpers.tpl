{{- define "selfnote.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "selfnote.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "selfnote.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "selfnote.labels" -}}
app.kubernetes.io/name: {{ include "selfnote.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "selfnote.image" -}}
{{- $tag := .Values.image.tag | default .Chart.AppVersion -}}
{{- printf "%s/%s:%s" .Values.image.registry .component $tag -}}
{{- end -}}

{{- define "selfnote.pgClusterName" -}}
{{- printf "%s-pg" (include "selfnote.fullname" .) -}}
{{- end -}}

{{- define "selfnote.minioName" -}}
{{- printf "%s-minio" .Release.Name -}}
{{- end -}}
