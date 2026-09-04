package controller

import (
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
)

func nonEmpty(v, def string) string {
	if v == "" {
		return def
	}
	return v
}

func replicasOr(v int32) int32 {
	if v == 0 {
		return 2
	}
	return v
}

func replicasOrN(v, def int32) int32 {
	if v == 0 {
		return def
	}
	return v
}

func secretEnv(name, secret, key string) corev1.EnvVar {
	return corev1.EnvVar{
		Name: name,
		ValueFrom: &corev1.EnvVarSource{
			SecretKeyRef: &corev1.SecretKeySelector{
				LocalObjectReference: corev1.LocalObjectReference{Name: secret},
				Key:                  key,
			},
		},
	}
}

func intstrFromInt(p int32) intstr.IntOrString {
	return intstr.FromInt32(p)
}
