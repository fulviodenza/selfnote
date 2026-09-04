package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ComponentSpec configures one of the Selfnote services.
type ComponentSpec struct {
	// +kubebuilder:default=2
	Replicas int32 `json:"replicas,omitempty"`
	// Image name (without registry); the registry comes from spec.imageRegistry.
	Image string `json:"image,omitempty"`
}

// BackupSpec configures CloudNativePG continuous + scheduled backups.
type BackupSpec struct {
	// +kubebuilder:default=true
	Enabled bool `json:"enabled,omitempty"`
	// +kubebuilder:default="0 0 2 * * *"
	Schedule string `json:"schedule,omitempty"`
	// e.g. s3://selfnote-backups/pg
	DestinationPath string `json:"destinationPath,omitempty"`
	// S3-compatible endpoint (MinIO), e.g. http://<release>-minio:9000
	EndpointURL string `json:"endpointURL,omitempty"`
	// Name of the Secret holding ACCESS_KEY_ID / ACCESS_SECRET_KEY.
	CredentialsSecret string `json:"credentialsSecret,omitempty"`
}

// PostgresSpec configures the managed Postgres cluster.
type PostgresSpec struct {
	// +kubebuilder:default=3
	Instances int32 `json:"instances,omitempty"`
	// +kubebuilder:default="10Gi"
	StorageSize string     `json:"storageSize,omitempty"`
	Backup      BackupSpec `json:"backup,omitempty"`
}

// SelfnoteSpec is the desired state of a Selfnote instance.
type SelfnoteSpec struct {
	// Application version / image tag.
	// +kubebuilder:default="0.1.0"
	Version string `json:"version,omitempty"`
	// Public hostname for the Ingress.
	Host string `json:"host,omitempty"`
	// Container image registry, e.g. ghcr.io/fulviodenza.
	// +kubebuilder:default="ghcr.io/fulviodenza"
	ImageRegistry string `json:"imageRegistry,omitempty"`
	// Name of the Secret with JWT_SECRET / ROOM_SECRET.
	AppSecret string        `json:"appSecret,omitempty"`
	Sync      ComponentSpec `json:"sync,omitempty"`
	API       ComponentSpec `json:"api,omitempty"`
	Web       ComponentSpec `json:"web,omitempty"`
	Postgres  PostgresSpec  `json:"postgres,omitempty"`
}

// SelfnoteStatus is the observed state of a Selfnote instance.
type SelfnoteStatus struct {
	// Conditions: Ready, DBReady, BackupHealthy.
	Conditions         []metav1.Condition `json:"conditions,omitempty"`
	ObservedGeneration int64              `json:"observedGeneration,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:shortName=sn
// +kubebuilder:printcolumn:name="Host",type=string,JSONPath=`.spec.host`
// +kubebuilder:printcolumn:name="Version",type=string,JSONPath=`.spec.version`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`

// Selfnote is a self-hosted collaborative workspace instance.
type Selfnote struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   SelfnoteSpec   `json:"spec,omitempty"`
	Status SelfnoteStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// SelfnoteList contains a list of Selfnote.
type SelfnoteList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []Selfnote `json:"items"`
}

func init() {
	SchemeBuilder.Register(&Selfnote{}, &SelfnoteList{})
}
