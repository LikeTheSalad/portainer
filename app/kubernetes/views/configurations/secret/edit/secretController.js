import angular from 'angular';
import _ from 'lodash-es';

import { KubernetesConfigurationFormValues } from 'Kubernetes/models/configuration/formvalues';
import { KubernetesConfigurationKinds, KubernetesSecretTypeOptions } from 'Kubernetes/models/configuration/models';
import KubernetesConfigurationHelper from 'Kubernetes/helpers/configurationHelper';
import KubernetesConfigurationConverter from 'Kubernetes/converters/configuration';
import KubernetesEventHelper from 'Kubernetes/helpers/eventHelper';
import KubernetesNamespaceHelper from 'Kubernetes/helpers/namespaceHelper';

import { pluralize } from '@/portainer/helpers/strings';

import { confirmUpdate, confirmWebEditorDiscard } from '@@/modals/confirm';
import { isConfigurationFormValid } from '../../validation';

class KubernetesSecretController {
  /* @ngInject */
  constructor(
    $async,
    $state,
    $window,
    clipboard,
    Notifications,
    LocalStorage,
    KubernetesConfigurationService,
    KubernetesSecretService,
    KubernetesResourcePoolService,
    KubernetesApplicationService,
    KubernetesEventService
  ) {
    this.$async = $async;
    this.$state = $state;
    this.$window = $window;
    this.clipboard = clipboard;
    this.Notifications = Notifications;
    this.LocalStorage = LocalStorage;
    this.KubernetesConfigurationService = KubernetesConfigurationService;
    this.KubernetesResourcePoolService = KubernetesResourcePoolService;
    this.KubernetesApplicationService = KubernetesApplicationService;
    this.KubernetesEventService = KubernetesEventService;
    this.KubernetesConfigurationKinds = KubernetesConfigurationKinds;
    this.KubernetesSecretTypeOptions = KubernetesSecretTypeOptions;
    this.KubernetesSecretService = KubernetesSecretService;

    this.onInit = this.onInit.bind(this);
    this.getConfigurationAsync = this.getConfigurationAsync.bind(this);
    this.getEvents = this.getEvents.bind(this);
    this.getEventsAsync = this.getEventsAsync.bind(this);
    this.getApplications = this.getApplications.bind(this);
    this.getApplicationsAsync = this.getApplicationsAsync.bind(this);
    this.updateConfiguration = this.updateConfiguration.bind(this);
    this.updateConfigurationAsync = this.updateConfigurationAsync.bind(this);
  }

  isSystemNamespace() {
    return KubernetesNamespaceHelper.isSystemNamespace(this.configuration.Namespace);
  }

  isSystemConfig() {
    return this.isSystemNamespace() || this.configuration.IsRegistrySecret;
  }

  selectTab(index) {
    this.LocalStorage.storeActiveTab('configuration', index);
  }

  showEditor() {
    this.state.showEditorTab = true;
    this.selectTab(2);
  }

  copyConfigurationValue(idx) {
    this.clipboard.copyText(this.formValues.Data[idx].Value);
    $('#copyValueNotification_' + idx)
      .show()
      .fadeOut(2500);
  }

  isFormValid() {
    const [isValid, warningMessage] = isConfigurationFormValid(this.state.alreadyExist, this.state.isDataValid, this.formValues);
    this.state.secretWarningMessage = warningMessage;
    return isValid;
  }

  // TODO: refactor
  // It looks like we're still doing a create/delete process but we've decided to get rid of this
  // approach.
  async updateConfigurationAsync() {
    try {
      this.state.actionInProgress = true;
      if (this.formValues.Kind !== this.configuration.Kind || this.formValues.ResourcePool !== this.configuration.Namespace || this.formValues.Name !== this.configuration.Name) {
        await this.KubernetesConfigurationService.create(this.formValues);
        await this.KubernetesConfigurationService.delete(this.configuration);
        this.Notifications.success('Success', `Secret successfully updated`);
        this.$state.go(
          'kubernetes.secrets.secret',
          {
            namespace: this.formValues.ResourcePool,
            name: this.formValues.Name,
          },
          { reload: true }
        );
      } else {
        await this.KubernetesConfigurationService.update(this.formValues, this.configuration);
        this.Notifications.success('Success', `Secret successfully updated`);
        this.$state.reload(this.$state.current);
      }
    } catch (err) {
      this.Notifications.error('Failure', err, `Unable to update Secret`);
    } finally {
      this.state.actionInProgress = false;
    }
  }

  updateConfiguration() {
    if (this.configuration.Used) {
      confirmUpdate(
        `The changes will be propagated to ${this.configuration.Applications.length} running ${pluralize(
          this.configuration.Applications.length,
          'application'
        )}. Are you sure you want to update this Secret?`,
        (confirmed) => {
          if (confirmed) {
            return this.$async(this.updateConfigurationAsync);
          }
        }
      );
    } else {
      return this.$async(this.updateConfigurationAsync);
    }
  }

  async getConfigurationAsync() {
    try {
      this.state.configurationLoading = true;
      const name = this.$transition$.params().name;
      const namespace = this.$transition$.params().namespace;
      try {
        const secret = await this.KubernetesSecretService.get(namespace, name);
        this.configuration = KubernetesConfigurationConverter.secretToConfiguration(secret);
        this.formValues.Data = secret.Data;
      } catch (err) {
        if (err.status === 403) {
          this.$state.go('kubernetes.configurations', { tab: 'secrets' });
          throw new Error('Not authorized to edit secret');
        }
      }
      this.formValues.ResourcePool = this.configuration.Namespace;
      this.formValues.Id = this.configuration.Id;
      this.formValues.Name = this.configuration.Name;
      this.formValues.Type = this.configuration.Type;
      this.formValues.Kind = this.configuration.Kind;
      this.oldDataYaml = this.formValues.DataYaml;
      this.formValues.Labels = this.configuration.Labels;

      return this.configuration;
    } catch (err) {
      this.Notifications.error('Failure', err, 'Unable to retrieve secret');
    } finally {
      this.state.configurationLoading = false;
    }
  }

  getConfiguration() {
    return this.$async(this.getConfigurationAsync);
  }

  async getApplicationsAsync(namespace) {
    try {
      this.state.applicationsLoading = true;
      const applications = await this.KubernetesApplicationService.get(namespace);
      this.configuration.Applications = KubernetesConfigurationHelper.getUsingApplications(this.configuration, applications);
      KubernetesConfigurationHelper.setConfigurationUsed(this.configuration);
    } catch (err) {
      this.Notifications.error('Failure', err, 'Unable to retrieve applications');
    } finally {
      this.state.applicationsLoading = false;
    }
  }

  getApplications(namespace) {
    return this.$async(this.getApplicationsAsync, namespace);
  }

  hasEventWarnings() {
    return this.state.eventWarningCount;
  }

  async getEventsAsync(namespace) {
    try {
      this.state.eventsLoading = true;
      this.events = await this.KubernetesEventService.get(namespace);
      this.events = _.filter(this.events, (event) => event.Involved.uid === this.configuration.Id);
      this.state.eventWarningCount = KubernetesEventHelper.warningCount(this.events);
    } catch (err) {
      this.Notifications('Failure', err, 'Unable to retrieve events');
    } finally {
      this.state.eventsLoading = false;
    }
  }

  getEvents(namespace) {
    return this.$async(this.getEventsAsync, namespace);
  }

  tagUsedDataKeys() {
    const configName = this.$transition$.params().name;
    const usedDataKeys = _.uniq(
      this.configuration.Applications.flatMap((app) =>
        app.Env.filter((e) => e.valueFrom && e.valueFrom.configMapKeyRef && e.valueFrom.configMapKeyRef.name === configName).map((e) => e.name)
      )
    );

    this.formValues.Data = this.formValues.Data.map((variable) => {
      if (!usedDataKeys.includes(variable.Key)) {
        return variable;
      }

      return { ...variable, Used: true };
    });
  }

  async uiCanExit() {
    if (!this.formValues.IsSimple && this.formValues.DataYaml !== this.oldDataYaml && this.state.isEditorDirty) {
      return confirmWebEditorDiscard();
    }
  }

  async onInit() {
    try {
      this.state = {
        actionInProgress: false,
        configurationLoading: true,
        applicationsLoading: true,
        eventsLoading: true,
        showEditorTab: false,
        viewReady: false,
        eventWarningCount: 0,
        activeTab: 0,
        currentName: this.$state.$current.name,
        isDataValid: true,
        isEditorDirty: false,
        isDockerConfig: false,
        secretWarningMessage: '',
      };

      this.state.activeTab = this.LocalStorage.getActiveTab('configuration');

      this.formValues = new KubernetesConfigurationFormValues();

      const configuration = await this.getConfiguration();
      if (configuration) {
        await this.getApplications(this.configuration.Namespace);
        await this.getEvents(this.configuration.Namespace);
      }

      // after loading the configuration, check if it is a docker config secret type
      if (
        this.formValues.Kind === this.KubernetesConfigurationKinds.SECRET &&
        (this.formValues.Type === this.KubernetesSecretTypeOptions.DOCKERCONFIGJSON.value || this.formValues.Type === this.KubernetesSecretTypeOptions.DOCKERCFG.value)
      ) {
        this.state.isDockerConfig = true;
      }
      // convert the secret type to a human readable value
      if (this.formValues.Type) {
        const secretTypeValues = Object.values(this.KubernetesSecretTypeOptions);
        const secretType = secretTypeValues.find((secretType) => secretType.value === this.formValues.Type);
        this.secretTypeName = secretType ? secretType.name : this.formValues.Type;
      } else {
        this.secretTypeName = '';
      }

      if (this.formValues.Type === this.KubernetesSecretTypeOptions.SERVICEACCOUNTTOKEN.value) {
        this.formValues.ServiceAccountName = configuration.ServiceAccountName;
      }

      this.tagUsedDataKeys();
    } catch (err) {
      this.Notifications.error('Failure', err, 'Unable to load view data');
    } finally {
      this.state.viewReady = true;
    }

    this.$window.onbeforeunload = () => {
      if (!this.formValues.IsSimple && this.formValues.DataYaml !== this.oldDataYaml && this.state.isEditorDirty) {
        return '';
      }
    };
  }

  $onInit() {
    return this.$async(this.onInit);
  }

  $onDestroy() {
    if (this.state.currentName !== this.$state.$current.name) {
      this.LocalStorage.storeActiveTab('configuration', 0);
    }
    this.state.isEditorDirty = false;
  }
}

export default KubernetesSecretController;
angular.module('portainer.kubernetes').controller('KubernetesSecretController', KubernetesSecretController);
