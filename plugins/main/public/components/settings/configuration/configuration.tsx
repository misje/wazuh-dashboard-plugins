/*
 * Wazuh app - React component building the configuration component.
 *
 * Copyright (C) 2015-2022 Wazuh, Inc.
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 2 of the License, or
 * (at your option) any later version.
 *
 * Find more information about this on the LICENSE file.
 */

import React, { useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { Header, BottomBar } from './components';
import { useKbnLoadingIndicator } from '../../common/hooks';
import { useForm } from '../../common/form/hooks';
import {
  EuiFlexGroup,
  EuiPage,
  EuiPageBody,
  EuiPageHeader,
  EuiSpacer,
  Query,
} from '@elastic/eui';
import {
  withUserAuthorizationPrompt,
  withErrorBoundary,
  withReduxProvider,
} from '../../common/hocs';
import {
  EpluginSettingType,
  UI_LOGGER_LEVELS,
} from '../../../../common/constants';
import { compose } from 'redux';
import { Category } from './components/categories/components';
import { WzRequest } from '../../../react-services';
import {
  UIErrorLog,
  UIErrorSeverity,
  UILogLevel,
  UI_ERROR_SEVERITIES,
} from '../../../react-services/error-orchestrator/types';
import { getErrorOrchestrator } from '../../../react-services/common-services';
import { updateAppConfig } from '../../../redux/actions/appConfigActions';
import path from 'path';
import {
  toastRequiresReloadingBrowserTab,
  toastRequiresRestartingPluginPlatform,
  toastRequiresRunningHealthcheck,
  toastSuccessUpdateConfiguration,
} from './components/categories/components/show-toasts';
import { getWazuhCorePlugin } from '../../../kibana-services';

export type ISetting = {
  key: string;
  value: boolean | string | number | object;
  description: string;
  category: string;
  name: string;
  readonly?: boolean;
  form: { type: string; params: {} };
};

const transformPluginSettingsToFormFields = (configuration, pluginSettings) => {
  return Object.entries(pluginSettings)
    .filter(([_, { isConfigurableFromSettings }]) => isConfigurableFromSettings)
    .reduce(
      (
        accum,
        [
          key,
          {
            type,
            validate,
            defaultValue: initialValue,
            uiFormTransformChangedInputValue,
            uiFormTransformConfigurationValueToInputValue,
            uiFormTransformInputValueToConfigurationValue,
            ...rest
          },
        ],
      ) => {
        return {
          ...accum,
          [key]: ['arrayOf'].includes(type)
            ? {
                type,
                initialValue: configuration[key].map(config => config),
                fields: transformPluginSettingsToFormFields(
                  configuration[key],
                  rest.options.arrayOf,
                ),
              }
            : {
                type,
                validate: validate?.bind?.(rest),
                transformChangedInputValue:
                  uiFormTransformChangedInputValue?.bind?.(rest),
                transformChangedOutputValue:
                  uiFormTransformInputValueToConfigurationValue?.bind?.(rest),
                initialValue: uiFormTransformConfigurationValueToInputValue
                  ? uiFormTransformConfigurationValueToInputValue.bind(rest)(
                      configuration?.[key] ?? initialValue,
                    )
                  : configuration?.[key] ?? initialValue,
                defaultValue: uiFormTransformConfigurationValueToInputValue
                  ? uiFormTransformConfigurationValueToInputValue.bind(rest)(
                      initialValue,
                    )
                  : initialValue,
                options: rest.options,
              },
        };
      },
      {},
    );
};

/**
 * Group the settings by category
 * @param settings
 * @returns
 */
function groupSettingsByCategory(settings: any[], categories: any[]) {
  const settingsSortedByCategories = settings
    .sort((settingA, settingB) => settingA.key?.localeCompare?.(settingB.key))
    .reduce(
      (accum, pluginSettingConfiguration) => ({
        ...accum,
        [pluginSettingConfiguration.category]: [
          ...(accum[pluginSettingConfiguration.category] || []),
          { ...pluginSettingConfiguration },
        ],
      }),
      {},
    );

  return Object.entries(settingsSortedByCategories)
    .map(([category, settings]) => ({ category, settings }))
    .filter(categoryEntry => categoryEntry.settings.length)
    .sort(
      (a, b) =>
        (categories.find(({ title }) => title === a.category)?.renderOrder ||
          0) -
        (categories.find(({ title }) => title === b.category)?.renderOrder ||
          0),
    );
}

const WzConfigurationSettingsProvider = props => {
  const [loading, setLoading] = useKbnLoadingIndicator();
  const [query, setQuery] = useState('');
  const currentConfiguration = useSelector(state => state.appConfig.data);

  const {
    fields,
    changed,
    errors,
    doChanges,
    undoChanges,
    forEach: formForEach,
  } = useForm(
    transformPluginSettingsToFormFields(
      currentConfiguration,
      Object.fromEntries(
        getWazuhCorePlugin().configuration._settings.entries(),
      ),
    ),
  );
  const dispatch = useDispatch();

  const onChangeSearchQuery = query => {
    setQuery(query);
  };

  const visibleSettings = Object.entries(fields).map(
    ([fieldKey, fieldForm]) => {
      const pluginSetting =
        getWazuhCorePlugin().configuration._settings.get(fieldKey);
      const _categoryMeta = getWazuhCorePlugin().configuration._categories.get(
        String(pluginSetting.category),
      );
      return {
        ...fieldForm,
        key: fieldKey,
        category: _categoryMeta.title,
        _categoryMeta,
        type: pluginSetting.type,
        options: pluginSetting?.options,
        title: pluginSetting?.title,
        description:
          getWazuhCorePlugin().configuration.getSettingDescription(fieldKey),
      };
    },
  );

  // https://github.com/elastic/eui/blob/aa4cfd7b7c34c2d724405a3ecffde7fe6cf3b50f/src/components/search_bar/query/query.ts#L138-L163
  const search = Query.execute(query.query || query, visibleSettings, [
    'description',
    'key',
    'title',
  ]);

  const visibleCategories = groupSettingsByCategory(
    search || visibleSettings,
    Array.from(getWazuhCorePlugin().configuration._categories.values()),
  );

  const onSave = async () => {
    setLoading(true);
    try {
      const settingsToUpdate = Object.entries(changed).reduce(
        (accum, [pluginSettingKey, currentValue]) => {
          const pluginSetting =
            getWazuhCorePlugin().configuration._settings.get(pluginSettingKey);
          if (
            pluginSetting.isConfigurableFromSettings &&
            pluginSetting.type === EpluginSettingType.filepicker
          ) {
            accum.fileUpload = {
              ...accum.fileUpload,
              [pluginSettingKey]: {
                file: currentValue,
                extension: path.extname(currentValue.name),
              },
            };
          } else if (pluginSetting.isConfigurableFromSettings) {
            accum.saveOnConfigurationFile = {
              ...accum.saveOnConfigurationFile,
              [pluginSettingKey]: currentValue,
            };
          }
          return accum;
        },
        { saveOnConfigurationFile: {}, fileUpload: {} },
      );

      const requests = [];

      // Update the settings that doesn't upload a file
      if (Object.keys(settingsToUpdate.saveOnConfigurationFile).length) {
        requests.push(
          WzRequest.genericReq(
            'PUT',
            '/utils/configuration',
            settingsToUpdate.saveOnConfigurationFile,
          ),
        );
      }

      // Update the settings that uploads a file
      if (Object.keys(settingsToUpdate.fileUpload).length) {
        requests.push(
          ...Object.entries(settingsToUpdate.fileUpload).map(
            ([pluginSettingKey, { file }]) => {
              // Create the form data
              const formData = new FormData();
              formData.append('file', file);
              return WzRequest.genericReq(
                'PUT',
                `/utils/configuration/files/${pluginSettingKey}`,
                formData,
                { overwriteHeaders: { 'content-type': 'multipart/form-data' } },
              );
            },
          ),
        );
      }

      const responses = await Promise.all(requests);

      // Show the toasts if necessary
      responses.some(
        ({
          data: {
            data: { requiresRunningHealthCheck },
          },
        }) => requiresRunningHealthCheck,
      ) && toastRequiresRunningHealthcheck();
      responses.some(
        ({
          data: {
            data: { requiresReloadingBrowserTab },
          },
        }) => requiresReloadingBrowserTab,
      ) && toastRequiresReloadingBrowserTab();
      responses.some(
        ({
          data: {
            data: { requiresRestartingPluginPlatform },
          },
        }) => requiresRestartingPluginPlatform,
      ) && toastRequiresRestartingPluginPlatform();

      // Update the app configuration frontend-cached setting in memory with the new values
      const updatedConfiguration = {
        ...responses.reduce((accum, { data: { data } }) => {
          return {
            ...accum,
            ...(data.updatedConfiguration
              ? { ...data.updatedConfiguration }
              : {}),
          };
        }, {}),
      };
      dispatch(updateAppConfig(updatedConfiguration));

      // Remove the selected files on the file picker inputs
      if (Object.keys(settingsToUpdate.fileUpload).length) {
        Object.keys(settingsToUpdate.fileUpload).forEach(settingKey => {
          try {
            fields[settingKey].inputRef.removeFiles(
              // This method uses some methods of a DOM event.
              // Because we want to remove the files when the configuration is saved,
              // there is no event, so we create a object that contains the
              // methods used to remove the files. Of this way, we can skip the errors
              // due to missing methods.
              // This workaround is based in @elastic/eui v29.3.2
              // https://github.com/elastic/eui/blob/v29.3.2/src/components/form/file_picker/file_picker.tsx#L107-L108
              { stopPropagation: () => {}, preventDefault: () => {} },
            );
          } catch (error) {}
        });
      }

      // Show the success toast
      toastSuccessUpdateConfiguration();

      // Reset the form changed configuration
      doChanges();
    } catch (error) {
      const options: UIErrorLog = {
        context: `${WzConfigurationSettingsProvider.name}.onSave`,
        level: UI_LOGGER_LEVELS.ERROR as UILogLevel,
        severity: UI_ERROR_SEVERITIES.BUSINESS as UIErrorSeverity,
        store: true,
        error: {
          error: error,
          message: error.message || error,
          title: `Error saving the configuration: ${error.message || error}`,
        },
      };

      getErrorOrchestrator().handleError(options);
    } finally {
      setLoading(false);
    }
  };

  const onCancel = () => {
    formForEach((state, _, { fieldDefinition }) => {
      if (fieldDefinition?.options?.file) {
        try {
          state.inputRef.removeFiles(
            // This method uses some methods of a DOM event.
            // Because we want to remove the files when the configuration is saved,
            // there is no event, so we create a object that contains the
            // methods used to remove the files. Of this way, we can skip the errors
            // due to missing methods.
            // This workaround is based in @elastic/eui v29.3.2
            // https://github.com/elastic/eui/blob/v29.3.2/src/components/form/file_picker/file_picker.tsx#L107-L108
            { stopPropagation: () => {}, preventDefault: () => {} },
          );
        } catch (error) {}
      }
    });
    undoChanges();
  };

  return (
    <EuiPage>
      <EuiPageBody className='mgtPage__body' restrictWidth>
        <EuiPageHeader>
          <Header
            query={query}
            setQuery={onChangeSearchQuery}
            searchBarFilters={[
              {
                type: 'field_value_selection',
                field: 'category',
                name: 'Categories',
                multiSelect: 'or',
                options: getWazuhCorePlugin()
                  .configuration.getUniqueCategories()
                  .map(({ title }) => ({ value: title })),
              },
            ]}
          />
        </EuiPageHeader>
        <EuiFlexGroup direction='column'>
          {visibleCategories &&
            visibleCategories.map(({ category, settings }) => {
              const { description, documentationLink, title } = Array.from(
                getWazuhCorePlugin().configuration._categories.values(),
              ).find(({ title: categoryTitle }) => categoryTitle === category);
              return (
                <Category
                  key={`configuration_category_${title}`}
                  title={title}
                  description={description}
                  documentationLink={documentationLink}
                  items={settings}
                  currentConfiguration={currentConfiguration}
                />
              );
            })}
        </EuiFlexGroup>
        <EuiSpacer size='xxl' />
        {Object.keys(changed).length > 0 && (
          <BottomBar
            errorsCount={Object.keys(errors).length}
            unsavedCount={Object.keys(changed).length}
            onCancel={onCancel}
            onSave={onSave}
          />
        )}
      </EuiPageBody>
    </EuiPage>
  );
};
export const WzConfigurationSettings = compose(
  withErrorBoundary,
  withReduxProvider,
  withUserAuthorizationPrompt(null, { isAdmininistrator: true }),
)(WzConfigurationSettingsProvider);
