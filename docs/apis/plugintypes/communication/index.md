---
title: Communication
tags:
- communication
- provider
- Communication provider
- Communication room
- Communication service
- Chat
---

Communication plugin allows you to create a communication provider plugin, which can be added as a part of course or any other instances.
For example, if you want to create a new communication room and add users to that room when a new course or instance is created, you can
create a new communication plugin and or use the existing ones and when a instance is created, updated or deleted, the communication api
will align those changes in the provider plugin asynchronously using a scheduled task.

import {
Lang,
} from '../../_files';

## File structure

Communication plugins are located in the /communication/provider directory. A plugin should not include any custom files outside its own
plugin folder.

Each plugin is in a separate subdirectory and consists of a number of _mandatory files_ and any other files the developer is going to use.

:::important

Some important files are described below. See the [common plugin files](../../commonfiles/index.mdx) documentation for details of other
files which may be useful in your plugin.

:::

<details>
  <summary>The directory layout for the `communication` plugin.</summary>

```console
communication/provider/example
├── classes
│   ├── communication_feature.php
│   ├── example_room.php
│   ├── example_user.php
│   ├── example_form.php
│   └── privacy
│       └── provider.php
├── lang
│   └── en
│       └── communication_example.php
├── settings.php
└── version.php
```

</details>

:::info

You will notice that there are a couple of classes named as example as a prefix, these are feature classes and can be named however
you like. These are feature classes which will be defined from the communication_feature.php from the plugin.

:::

## Creating a new plugin

:::info

TBA after implementing MDL-76796

:::

### Generating the plugin skeleton

:::info

TBA after implementing MDL-76796

:::

## Key files

There are a number of key files within the plugin, described below.

### example_room.php

The example_room.php is the extended class of communication_room_base.php, and it will define the features for creating a room.
The name of the class is not mandatory to follow like this, but it must extend communication_room_base and all the actions should
go to the implemented methods of the class. Let's look at the methods of this class to get a better idea.

#### Communication object and init()

This class will have the communication object from the base class and any other actions needed to be done as a part of initialization
can be called from init() method. The communication object will have all the required information for the plugin room creation or
any other management. That means plugins wont need to pass or get information any other way as all the required information will live
in the communication object and plugins can easily call that object get to use those data.

#### create()

All the necessary actions to create a provider room should be done here.

#### update()

All the necessary actions to update a provider room should live here. It is highly recommended to add necessary checking to compare the
data passed and previous data to ensure something is changed and an update is required to make sure no unnecessary api calls are made.

#### delete()

!!Danger zone!! Any deletion or related action for the communication room should live here. Please be-careful with your actions here.

#### generate_room_url()

Generate a room url according to the room information, web client url or any other required information.

### example_user.php

The example_room.php is the extended class of communication_user_base.php, and it will define the features for creating users,
adding members to the room or removing members from the room. The name of the class is not mandatory to follow like this, but
it must extend communication_user_base and all the actions should go to the implemented methods of the class. Let's look at the
methods of this class to get a better idea.

#### Communication object and init()

As explained above, this class will also have the communication object and same way it can get all the required information. And
any required call can live in the init.

#### create_members()

All the necessary actions to create members for the room should live here. It is not a required method to implemented, some APIs
might not need to create user as they might have been created in a different way.

#### add_members_to_room()

All the necessary actions to add members to a room should live here.

#### remove_members_from_room()

All the necessary actions to remove members from a room should live here.

### example_form.php

Communication plugins can add custom form elements as a part of the plugin. For example, while creating an instance or course, if
the communication api is used there, it will generate the form fields to select the communication provider and name of the room to
start with enabling a communication feature for a course or instance. Now, if the selected communication plugin requires or can have
some more information to be added as a part of that feature, it can define those fields from the plugin and the communication api will
pick them up and generate them in the form. For example, a communication room name is coming from the communication api, but a specific
communication plugin required to have a description of the room, it can define that form field from the plugin and communication api
will generate that while getting all the information from user at the same time while creating a communication feature. There are methods
a plugin implement as a part of this. They are explained below.

#### get_form_data_options()

This will have list of options as an array which will be used while saving the data from the instance. For example, if there was two form
fields implemented from the plugin, 'description' and 'room rules' these two values must be added as an array in this method to help the
communication api understand which data to grab and send to the plugin for storing and other actions.

#### set_form_data()

This method will be used by instance form to set any data if there is an existing data and can be shown while editing a communication
feature from a course or instance.

#### set_form_definition()

This method will have the actual form definition to be added as a part of the communication api from the selected communication plugin.

### communication_feature.php

Each plugin must implement/extend this class and should have the exact class name. This part is important for the core communication api.
The core communication api will pick the features and actions from this class. This class should extend communication_feature_base.php
and pass each feature as an object. For example, to pass the communication room, user and form feature as an object from the example plugin, it
should do something like this:

```php
class communication_feature extends communication_feature_base {

    public function get_provider_room(communication $communication): example_room {
        return new example_room($communication);
    }

    public function get_provider_user(communication $communication): example_user {
        return new example_user($communication);
    }

    public function get_provider_form_definition(): example_form {
        return new example_form();
    }

}
```

:::info

For a real plugin example, please look at the [Matrix plugin](https://github.com/moodle/moodle/tree/master/communication/provider/matrix).

:::
