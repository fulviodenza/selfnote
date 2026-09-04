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

{{- /* Name of the Secret holding AI credentials — either one you pre-created
       (ai.existingSecret) or the chart-managed one. */ -}}
{{- define "selfnote.aiSecretName" -}}
{{- if .Values.ai.existingSecret -}}
{{- .Values.ai.existingSecret -}}
{{- else -}}
{{- printf "%s-ai" (include "selfnote.fullname" .) -}}
{{- end -}}
{{- end -}}

{{- /* True when the chart should render its own AI secret (inline credential
       given and no existingSecret referenced). */ -}}
{{- define "selfnote.aiManagesSecret" -}}
{{- if and .Values.ai.enabled (not .Values.ai.existingSecret) -}}
{{- if or (eq .Values.ai.provider "claude-cli") (eq .Values.ai.provider "anthropic") -}}
true
{{- end -}}
{{- end -}}
{{- end -}}
