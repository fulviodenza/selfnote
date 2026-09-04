// Package v1alpha1 contains the Selfnote CRD API.
// +kubebuilder:object:generate=true
// +groupName=selfnote.app
package v1alpha1

import (
	"k8s.io/apimachinery/pkg/runtime/schema"
	"sigs.k8s.io/controller-runtime/pkg/scheme"
)

var (
	// GroupVersion is group version used to register these objects.
	GroupVersion = schema.GroupVersion{Group: "selfnote.app", Version: "v1alpha1"}

	// SchemeBuilder registers the Go types with a runtime.Scheme.
	SchemeBuilder = &scheme.Builder{GroupVersion: GroupVersion}

	// AddToScheme adds the types in this group-version to a scheme.
	AddToScheme = SchemeBuilder.AddToScheme
)
