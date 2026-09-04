package controller

import (
	"context"
	"fmt"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/log"

	appv1alpha1 "github.com/fulviodenza/selfnote/operator/api/v1alpha1"
)

// SelfnoteReconciler reconciles a Selfnote object.
type SelfnoteReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// +kubebuilder:rbac:groups=selfnote.app,resources=selfnotes,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=selfnote.app,resources=selfnotes/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=apps,resources=deployments,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core,resources=services,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=postgresql.cnpg.io,resources=clusters;scheduledbackups,verbs=get;list;watch;create;update;patch;delete

func (r *SelfnoteReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	logger := log.FromContext(ctx)

	var sn appv1alpha1.Selfnote
	if err := r.Get(ctx, req.NamespacedName, &sn); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	// 1. Postgres (delegated to CloudNativePG).
	if err := r.reconcilePostgres(ctx, &sn); err != nil {
		return r.fail(ctx, &sn, "DBReady", err)
	}
	r.setCondition(&sn, "DBReady", metav1.ConditionTrue, "Reconciled", "postgres cluster reconciled")

	// 2. Application services.
	appSecret := sn.Spec.AppSecret
	pgSecret := fmt.Sprintf("%s-pg-app", sn.Name)
	components := []struct {
		name  string
		image string
		repl  int32
		port  int32
		env   []corev1.EnvVar
	}{
		{"sync", nonEmpty(sn.Spec.Sync.Image, "selfnote-sync"), replicasOr(sn.Spec.Sync.Replicas), 4444, []corev1.EnvVar{
			{Name: "SYNC_ADDR", Value: "0.0.0.0:4444"},
			{Name: "SYNC_REQUIRE_AUTH", Value: "1"},
			secretEnv("ROOM_SECRET", appSecret, "ROOM_SECRET"),
			secretEnv("DATABASE_URL", pgSecret, "uri"),
		}},
		{"api", nonEmpty(sn.Spec.API.Image, "selfnote-api"), replicasOr(sn.Spec.API.Replicas), 4445, []corev1.EnvVar{
			{Name: "API_ADDR", Value: "0.0.0.0:4445"},
			secretEnv("JWT_SECRET", appSecret, "JWT_SECRET"),
			secretEnv("ROOM_SECRET", appSecret, "ROOM_SECRET"),
			secretEnv("DATABASE_URL", pgSecret, "uri"),
		}},
		{"web", nonEmpty(sn.Spec.Web.Image, "selfnote-web"), replicasOr(sn.Spec.Web.Replicas), 80, nil},
	}

	for _, c := range components {
		image := fmt.Sprintf("%s/%s:%s", nonEmpty(sn.Spec.ImageRegistry, "ghcr.io/fulviodenza"), c.image, nonEmpty(sn.Spec.Version, "0.1.0"))
		if err := r.reconcileDeployment(ctx, &sn, c.name, image, c.repl, c.port, c.env); err != nil {
			return r.fail(ctx, &sn, "Ready", err)
		}
		if err := r.reconcileService(ctx, &sn, c.name, c.port); err != nil {
			return r.fail(ctx, &sn, "Ready", err)
		}
	}

	logger.Info("reconciled", "selfnote", sn.Name)
	return r.ready(ctx, &sn)
}

func (r *SelfnoteReconciler) reconcileDeployment(ctx context.Context, sn *appv1alpha1.Selfnote, comp, image string, replicas, port int32, env []corev1.EnvVar) error {
	name := fmt.Sprintf("%s-%s", sn.Name, comp)
	labels := map[string]string{"app.kubernetes.io/instance": sn.Name, "app.kubernetes.io/component": comp}
	dep := &appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: sn.Namespace}}

	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, dep, func() error {
		dep.Labels = labels
		dep.Spec.Replicas = &replicas
		dep.Spec.Selector = &metav1.LabelSelector{MatchLabels: labels}
		dep.Spec.Template.ObjectMeta.Labels = labels
		dep.Spec.Template.Spec.Containers = []corev1.Container{{
			Name:  comp,
			Image: image,
			Ports: []corev1.ContainerPort{{ContainerPort: port}},
			Env:   env,
		}}
		return controllerutil.SetControllerReference(sn, dep, r.Scheme)
	})
	return err
}

func (r *SelfnoteReconciler) reconcileService(ctx context.Context, sn *appv1alpha1.Selfnote, comp string, port int32) error {
	name := fmt.Sprintf("%s-%s", sn.Name, comp)
	labels := map[string]string{"app.kubernetes.io/instance": sn.Name, "app.kubernetes.io/component": comp}
	svc := &corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: sn.Namespace}}

	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, svc, func() error {
		svc.Labels = labels
		svc.Spec.Selector = labels
		svc.Spec.Ports = []corev1.ServicePort{{Port: port, TargetPort: intstrFromInt(port)}}
		return controllerutil.SetControllerReference(sn, svc, r.Scheme)
	})
	return err
}

// reconcilePostgres composes a CloudNativePG Cluster (we don't reimplement Postgres).
func (r *SelfnoteReconciler) reconcilePostgres(ctx context.Context, sn *appv1alpha1.Selfnote) error {
	pg := sn.Spec.Postgres
	cluster := &unstructured.Unstructured{}
	cluster.SetGroupVersionKind(schema.GroupVersionKind{Group: "postgresql.cnpg.io", Version: "v1", Kind: "Cluster"})
	cluster.SetName(fmt.Sprintf("%s-pg", sn.Name))
	cluster.SetNamespace(sn.Namespace)

	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, cluster, func() error {
		spec := map[string]interface{}{
			"instances": int64(replicasOrN(pg.Instances, 3)),
			"storage":   map[string]interface{}{"size": nonEmpty(pg.StorageSize, "10Gi")},
			"bootstrap": map[string]interface{}{
				"initdb": map[string]interface{}{"database": "selfnote", "owner": "selfnote"},
			},
		}
		if pg.Backup.Enabled && pg.Backup.DestinationPath != "" {
			credSecret := nonEmpty(pg.Backup.CredentialsSecret, fmt.Sprintf("%s-minio", sn.Name))
			spec["backup"] = map[string]interface{}{
				"barmanObjectStore": map[string]interface{}{
					"destinationPath": pg.Backup.DestinationPath,
					"endpointURL":     pg.Backup.EndpointURL,
					"s3Credentials": map[string]interface{}{
						"accessKeyId":     map[string]interface{}{"name": credSecret, "key": "ACCESS_KEY_ID"},
						"secretAccessKey": map[string]interface{}{"name": credSecret, "key": "ACCESS_SECRET_KEY"},
					},
					"wal": map[string]interface{}{"compression": "gzip"},
				},
			}
		}
		if err := unstructured.SetNestedMap(cluster.Object, spec, "spec"); err != nil {
			return err
		}
		return controllerutil.SetControllerReference(sn, cluster, r.Scheme)
	})
	return err
}

func (r *SelfnoteReconciler) ready(ctx context.Context, sn *appv1alpha1.Selfnote) (ctrl.Result, error) {
	r.setCondition(sn, "Ready", metav1.ConditionTrue, "Reconciled", "all components reconciled")
	sn.Status.ObservedGeneration = sn.Generation
	return ctrl.Result{}, r.Status().Update(ctx, sn)
}

func (r *SelfnoteReconciler) fail(ctx context.Context, sn *appv1alpha1.Selfnote, cond string, cause error) (ctrl.Result, error) {
	r.setCondition(sn, cond, metav1.ConditionFalse, "Error", cause.Error())
	_ = r.Status().Update(ctx, sn)
	return ctrl.Result{}, cause
}

func (r *SelfnoteReconciler) setCondition(sn *appv1alpha1.Selfnote, condType string, status metav1.ConditionStatus, reason, msg string) {
	meta := metav1.Condition{
		Type:               condType,
		Status:             status,
		Reason:             reason,
		Message:            msg,
		ObservedGeneration: sn.Generation,
		LastTransitionTime: metav1.Now(),
	}
	for i := range sn.Status.Conditions {
		if sn.Status.Conditions[i].Type == condType {
			sn.Status.Conditions[i] = meta
			return
		}
	}
	sn.Status.Conditions = append(sn.Status.Conditions, meta)
}

// SetupWithManager wires the controller to the manager.
func (r *SelfnoteReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&appv1alpha1.Selfnote{}).
		Owns(&appsv1.Deployment{}).
		Owns(&corev1.Service{}).
		Complete(r)
}
